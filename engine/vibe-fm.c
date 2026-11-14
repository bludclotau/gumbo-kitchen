/* vibe-fm — offline 3-voice, 2-operator FM renderer.
 *
 * The LLM never calls this. The orchestrator passes a validated JSON patch.
 * Same patch and seed render the same samples on this host and libm.
 *
 * Phase modulation matches the mod-tracker voice (fm-dsp.js): the modulator
 * sine is radians of carrier phase deviation. Gumbo's fmpair_tick adds the
 * modulator to a 0..1 cycle, so its "index" is not this index.
 *
 * index_env_amount blends which envelope scales that index:
 *   follow = (1 - amount) * modulator_adsr + amount * carrier_adsr
 * amount 1 is the brass case: the index follows the amplitude envelope.
 * Carrier ADSR is the amplitude envelope. All notes strike together.
 */
#define _POSIX_C_SOURCE 200809L

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

enum { LFO_OFF = 0, LFO_PITCH, LFO_INDEX, LFO_AMP, MAX_NOTES = 3 };

typedef struct {
    float ratio, detune_cents, index, index_env_amount;
    float attack, decay, sustain, release, level;
} Op;

typedef struct {
    float midi, velocity;
} Note;

typedef struct {
    float duration_s, gain, sample_rate;
    uint32_t seed;
    int nnotes;
    Note notes[MAX_NOTES];
    Op mod, car;
    float lfo_rate, lfo_depth;
    int lfo_target;
} Patch;

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } JType;

typedef struct JVal {
    JType type;
    double num;
    char *str;
    char *key;
    struct JVal *child;
    struct JVal *next;
} JVal;

typedef struct {
    char *base;
    size_t used;
    size_t cap;
} Arena;

typedef struct {
    const char *p;
    const char *end;
    Arena *arena;
    char err[160];
} Parser;

static void *arena_alloc(Arena *a, size_t n) {
    n = (n + 7u) & ~(size_t)7u;
    if (n > a->cap || a->used > a->cap - n) return NULL;
    void *p = a->base + a->used;
    a->used += n;
    memset(p, 0, n);
    return p;
}

static char *arena_str(Arena *a, const char *s, size_t n) {
    char *d = arena_alloc(a, n + 1);
    if (!d) return NULL;
    memcpy(d, s, n);
    d[n] = 0;
    return d;
}

static void skip(Parser *c) {
    while (c->p < c->end && isspace((unsigned char)*c->p)) c->p++;
}

static int fail(Parser *c, const char *msg) {
    snprintf(c->err, sizeof c->err, "%s", msg);
    return -1;
}

static JVal *parse_value(Parser *c);

static int parse_string_into(Parser *c, char **out) {
    if (c->p >= c->end || *c->p != '"') return fail(c, "expected string");
    c->p++;
    char buf[4096];
    size_t n = 0;
    while (c->p < c->end) {
        unsigned char ch = (unsigned char)*c->p++;
        if (ch == '"') {
            *out = arena_str(c->arena, buf, n);
            if (!*out) return fail(c, "patch too large");
            return 0;
        }
        if (ch == '\\') {
            if (c->p >= c->end) return fail(c, "bad escape");
            char e = *c->p++;
            switch (e) {
            case '"': case '\\': case '/': ch = (unsigned char)e; break;
            case 'b': ch = '\b'; break;
            case 'f': ch = '\f'; break;
            case 'n': ch = '\n'; break;
            case 'r': ch = '\r'; break;
            case 't': ch = '\t'; break;
            case 'u': {
                if (c->end - c->p < 4) return fail(c, "bad unicode escape");
                unsigned cp = 0;
                for (int i = 0; i < 4; i++) {
                    char h = *c->p++;
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp += (unsigned)(h - '0');
                    else if (h >= 'a' && h <= 'f') cp += (unsigned)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp += (unsigned)(h - 'A' + 10);
                    else return fail(c, "bad unicode escape");
                }
                if (cp < 0x80) ch = (unsigned char)cp;
                else if (cp < 0x800) {
                    if (n + 2 >= sizeof buf) return fail(c, "string too long");
                    buf[n++] = (char)(0xC0 | (cp >> 6));
                    ch = (unsigned char)(0x80 | (cp & 0x3F));
                } else {
                    if (n + 3 >= sizeof buf) return fail(c, "string too long");
                    buf[n++] = (char)(0xE0 | (cp >> 12));
                    buf[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    ch = (unsigned char)(0x80 | (cp & 0x3F));
                }
                break;
            }
            default: return fail(c, "bad escape");
            }
        }
        if (n + 1 >= sizeof buf) return fail(c, "string too long");
        buf[n++] = (char)ch;
    }
    return fail(c, "unterminated string");
}

static JVal *parse_number(Parser *c) {
    const char *start = c->p;
    if (c->p < c->end && (*c->p == '-' || *c->p == '+')) c->p++;
    if (c->p >= c->end || !isdigit((unsigned char)*c->p)) {
        fail(c, "expected number");
        return NULL;
    }
    while (c->p < c->end && isdigit((unsigned char)*c->p)) c->p++;
    if (c->p < c->end && *c->p == '.') {
        c->p++;
        if (c->p >= c->end || !isdigit((unsigned char)*c->p)) {
            fail(c, "bad number");
            return NULL;
        }
        while (c->p < c->end && isdigit((unsigned char)*c->p)) c->p++;
    }
    if (c->p < c->end && (*c->p == 'e' || *c->p == 'E')) {
        c->p++;
        if (c->p < c->end && (*c->p == '-' || *c->p == '+')) c->p++;
        if (c->p >= c->end || !isdigit((unsigned char)*c->p)) {
            fail(c, "bad exponent");
            return NULL;
        }
        while (c->p < c->end && isdigit((unsigned char)*c->p)) c->p++;
    }
    char tmp[64];
    size_t n = (size_t)(c->p - start);
    if (n == 0 || n >= sizeof tmp) {
        fail(c, "bad number");
        return NULL;
    }
    memcpy(tmp, start, n);
    tmp[n] = 0;
    char *end = NULL;
    double v = strtod(tmp, &end);
    if (end != tmp + n || !isfinite(v)) {
        fail(c, "bad number");
        return NULL;
    }
    JVal *val = arena_alloc(c->arena, sizeof *val);
    if (!val) {
        fail(c, "patch too large");
        return NULL;
    }
    val->type = J_NUM;
    val->num = v;
    return val;
}

static JVal *parse_value(Parser *c) {
    skip(c);
    if (c->p >= c->end) {
        fail(c, "unexpected end");
        return NULL;
    }
    char ch = *c->p;
    if (ch == '"') {
        char *s = NULL;
        if (parse_string_into(c, &s) != 0) return NULL;
        JVal *val = arena_alloc(c->arena, sizeof *val);
        if (!val) {
            fail(c, "patch too large");
            return NULL;
        }
        val->type = J_STR;
        val->str = s;
        return val;
    }
    if (ch == '-' || ch == '+' || isdigit((unsigned char)ch)) return parse_number(c);
    if (ch == 't' || ch == 'f' || ch == 'n') {
        const char *lit = ch == 't' ? "true" : ch == 'f' ? "false" : "null";
        size_t n = strlen(lit);
        if ((size_t)(c->end - c->p) < n || memcmp(c->p, lit, n) != 0) {
            fail(c, "bad literal");
            return NULL;
        }
        c->p += n;
        JVal *val = arena_alloc(c->arena, sizeof *val);
        if (!val) {
            fail(c, "patch too large");
            return NULL;
        }
        val->type = ch == 'n' ? J_NULL : J_BOOL;
        val->num = ch == 't' ? 1 : 0;
        return val;
    }
    if (ch == '{') {
        c->p++;
        JVal *obj = arena_alloc(c->arena, sizeof *obj);
        if (!obj) {
            fail(c, "patch too large");
            return NULL;
        }
        obj->type = J_OBJ;
        JVal *tail = NULL;
        skip(c);
        if (c->p < c->end && *c->p == '}') {
            c->p++;
            return obj;
        }
        for (;;) {
            skip(c);
            char *key = NULL;
            if (parse_string_into(c, &key) != 0) return NULL;
            for (JVal *s = obj->child; s; s = s->next) {
                if (strcmp(s->key, key) == 0) {
                    fail(c, "duplicate key");
                    return NULL;
                }
            }
            skip(c);
            if (c->p >= c->end || *c->p != ':') {
                fail(c, "expected colon");
                return NULL;
            }
            c->p++;
            JVal *child = parse_value(c);
            if (!child) return NULL;
            child->key = key;
            if (!tail) obj->child = child;
            else tail->next = child;
            tail = child;
            skip(c);
            if (c->p < c->end && *c->p == ',') {
                c->p++;
                continue;
            }
            if (c->p < c->end && *c->p == '}') {
                c->p++;
                return obj;
            }
            fail(c, "expected comma or }");
            return NULL;
        }
    }
    if (ch == '[') {
        c->p++;
        JVal *arr = arena_alloc(c->arena, sizeof *arr);
        if (!arr) {
            fail(c, "patch too large");
            return NULL;
        }
        arr->type = J_ARR;
        JVal *tail = NULL;
        skip(c);
        if (c->p < c->end && *c->p == ']') {
            c->p++;
            return arr;
        }
        for (;;) {
            JVal *child = parse_value(c);
            if (!child) return NULL;
            if (!tail) arr->child = child;
            else tail->next = child;
            tail = child;
            skip(c);
            if (c->p < c->end && *c->p == ',') {
                c->p++;
                continue;
            }
            if (c->p < c->end && *c->p == ']') {
                c->p++;
                return arr;
            }
            fail(c, "expected comma or ]");
            return NULL;
        }
    }
    fail(c, "unexpected token");
    return NULL;
}

static JVal *json_parse(const char *text, size_t len, Arena *arena, char *err, size_t errlen) {
    Parser c = { text, text + len, arena, "" };
    JVal *v = parse_value(&c);
    if (!v) {
        snprintf(err, errlen, "%s", c.err[0] ? c.err : "parse error");
        return NULL;
    }
    skip(&c);
    if (c.p != c.end) {
        snprintf(err, errlen, "trailing data");
        return NULL;
    }
    return v;
}

static const JVal *jget(const JVal *obj, const char *key) {
    if (!obj || obj->type != J_OBJ) return NULL;
    for (const JVal *c = obj->child; c; c = c->next) {
        if (c->key && strcmp(c->key, key) == 0) return c;
    }
    return NULL;
}

static int jnum(const JVal *obj, const char *key, double *out, char *err, size_t n) {
    const JVal *v = jget(obj, key);
    if (!v || v->type != J_NUM || !isfinite(v->num)) {
        snprintf(err, n, "missing number '%s'", key);
        return -1;
    }
    *out = v->num;
    return 0;
}

static int jstr(const JVal *obj, const char *key, const char **out, char *err, size_t n) {
    const JVal *v = jget(obj, key);
    if (!v || v->type != J_STR || !v->str) {
        snprintf(err, n, "missing string '%s'", key);
        return -1;
    }
    *out = v->str;
    return 0;
}

static int in_range(double v, double lo, double hi) {
    return v >= lo && v <= hi;
}

static int load_op(const JVal *obj, Op *op, int is_mod, char *err, size_t n) {
    if (!obj || obj->type != J_OBJ) {
        snprintf(err, n, "operator is not an object");
        return -1;
    }
    double ratio, detune, attack, decay, sustain, release, level;
    if (jnum(obj, "ratio", &ratio, err, n) ||
        jnum(obj, "detune_cents", &detune, err, n) ||
        jnum(obj, "attack", &attack, err, n) ||
        jnum(obj, "decay", &decay, err, n) ||
        jnum(obj, "sustain", &sustain, err, n) ||
        jnum(obj, "release", &release, err, n) ||
        jnum(obj, "level", &level, err, n)) return -1;
    double index = 0, amount = 0;
    if (is_mod) {
        if (jnum(obj, "index", &index, err, n) ||
            jnum(obj, "index_env_amount", &amount, err, n)) return -1;
        if (!in_range(index, 0, 8) || !in_range(amount, 0, 1)) {
            snprintf(err, n, "modulator index out of range");
            return -1;
        }
    }
    if (!in_range(ratio, 0.5, 8) || !in_range(detune, -50, 50) ||
        !in_range(attack, 0.001, 2) || !in_range(decay, 0.001, 2) ||
        !in_range(sustain, 0, 1) || !in_range(release, 0.001, 2) ||
        !in_range(level, 0, 1)) {
        snprintf(err, n, "operator field out of range");
        return -1;
    }
    op->ratio = (float)ratio;
    op->detune_cents = (float)detune;
    op->index = (float)index;
    op->index_env_amount = (float)amount;
    op->attack = (float)attack;
    op->decay = (float)decay;
    op->sustain = (float)sustain;
    op->release = (float)release;
    op->level = (float)level;
    return 0;
}

static int load_patch(const JVal *root, Patch *p, char *err, size_t n) {
    memset(p, 0, sizeof *p);
    if (!root || root->type != J_OBJ) {
        snprintf(err, n, "patch is not an object");
        return -1;
    }
    double duration, gain;
    if (jnum(root, "duration_s", &duration, err, n) ||
        jnum(root, "gain", &gain, err, n)) return -1;
    if (!in_range(duration, 0.05, 8) || !in_range(gain, 0, 0.8)) {
        snprintf(err, n, "duration_s or gain out of range");
        return -1;
    }
    p->duration_s = (float)duration;
    p->gain = (float)gain;
    p->sample_rate = 48000;
    p->seed = 1;
    const JVal *sr = jget(root, "sample_rate");
    if (sr) {
        if (sr->type != J_NUM || sr->num < 8000 || sr->num > 96000) {
            snprintf(err, n, "sample_rate out of range");
            return -1;
        }
        p->sample_rate = (float)sr->num;
    }
    const JVal *seed = jget(root, "seed");
    if (seed) {
        if (seed->type != J_NUM || seed->num < 0 || seed->num > 4294967295.0) {
            snprintf(err, n, "seed out of range");
            return -1;
        }
        p->seed = (uint32_t)seed->num;
    }
    const JVal *notes = jget(root, "notes");
    if (!notes || notes->type != J_ARR) {
        snprintf(err, n, "missing notes");
        return -1;
    }
    for (const JVal *note = notes->child; note; note = note->next) {
        if (p->nnotes >= MAX_NOTES) {
            snprintf(err, n, "more than 3 notes");
            return -1;
        }
        double midi, vel;
        if (jnum(note, "midi", &midi, err, n) || jnum(note, "velocity", &vel, err, n)) return -1;
        if (!in_range(midi, 36, 84) || !in_range(vel, 0.15, 1)) {
            snprintf(err, n, "note out of range");
            return -1;
        }
        p->notes[p->nnotes].midi = (float)midi;
        p->notes[p->nnotes].velocity = (float)vel;
        p->nnotes++;
    }
    if (p->nnotes < 1) {
        snprintf(err, n, "notes is empty");
        return -1;
    }
    if (load_op(jget(root, "modulator"), &p->mod, 1, err, n)) return -1;
    if (load_op(jget(root, "carrier"), &p->car, 0, err, n)) return -1;
    const JVal *lfo = jget(root, "lfo");
    double rate, depth;
    const char *target = NULL;
    if (jnum(lfo, "rate_hz", &rate, err, n) ||
        jnum(lfo, "depth", &depth, err, n) ||
        jstr(lfo, "target", &target, err, n)) return -1;
    if (!in_range(rate, 0, 12) || !in_range(depth, 0, 1)) {
        snprintf(err, n, "lfo out of range");
        return -1;
    }
    if (strcmp(target, "off") == 0) p->lfo_target = LFO_OFF;
    else if (strcmp(target, "pitch") == 0) p->lfo_target = LFO_PITCH;
    else if (strcmp(target, "index") == 0) p->lfo_target = LFO_INDEX;
    else if (strcmp(target, "amp") == 0) p->lfo_target = LFO_AMP;
    else {
        snprintf(err, n, "unknown lfo target");
        return -1;
    }
    p->lfo_rate = (float)rate;
    p->lfo_depth = (float)depth;
    return 0;
}

static double hash_phase(uint32_t seed, int voice, int which) {
    uint32_t x = seed + (uint32_t)(voice + 1) * 0x9E3779B9u + (uint32_t)which * 0x85EBCA6Bu;
    x ^= x >> 16;
    x *= 0x7FEB352Du;
    x ^= x >> 15;
    x *= 0x846CA68Bu;
    x ^= x >> 16;
    return (double)(x & 0xFFFFFFu) / (double)0x1000000u;
}

static float adsr_at(const Op *op, float t, float gate) {
    float a = op->attack < 1e-5f ? 1e-5f : op->attack;
    float d = op->decay < 1e-5f ? 1e-5f : op->decay;
    float rel = op->release < 1e-4f ? 1e-4f : op->release;
    float held;
    if (gate < a) held = gate / a;
    else if (gate < a + d) held = 1.0f + (op->sustain - 1.0f) * ((gate - a) / d);
    else held = op->sustain;
    if (t < gate) {
        if (t < a) return t / a;
        if (t < a + d) return 1.0f + (op->sustain - 1.0f) * ((t - a) / d);
        return op->sustain;
    }
    float u = (t - gate) / rel;
    if (u >= 1.0f) return 0.0f;
    if (u < 0.0f) u = 0.0f;
    return held * (1.0f - u);
}

static void wrap_phase(double *phase) {
    while (*phase >= 1.0) *phase -= 1.0;
    while (*phase < 0.0) *phase += 1.0;
}

/* index0 may be NULL. When set, it receives voice 0's modulation index per sample. */
static int render_patch(const Patch *p, float *out, int frames, float *index0) {
    if (frames < 1) return -1;
    double car_phase[MAX_NOTES], mod_phase[MAX_NOTES];
    for (int v = 0; v < p->nnotes; v++) {
        car_phase[v] = hash_phase(p->seed, v, 1);
        mod_phase[v] = hash_phase(p->seed, v, 2);
    }
    double lfo_phase = hash_phase(p->seed, 0, 3) * 2.0 * M_PI;
    float sr = p->sample_rate;
    float gate = p->duration_s - p->car.release;
    if (gate < 0.001f) gate = 0.001f;
    const float two_pi = (float)(2.0 * M_PI);

    for (int i = 0; i < frames; i++) {
        float t = (float)i / sr;
        float lfo = sinf(two_pi * p->lfo_rate * t + (float)lfo_phase);
        float bend = 1.0f;
        if (p->lfo_target == LFO_PITCH) {
            bend = powf(2.0f, (p->lfo_depth * lfo * 100.0f) / 1200.0f);
        }
        float sum = 0.0f;
        for (int v = 0; v < p->nnotes; v++) {
            float note_hz = 440.0f * powf(2.0f, (p->notes[v].midi - 69.0f) / 12.0f);
            float car_hz = note_hz * p->car.ratio * powf(2.0f, p->car.detune_cents / 1200.0f) * bend;
            float mod_hz = note_hz * p->mod.ratio * powf(2.0f, p->mod.detune_cents / 1200.0f) * bend;
            float amp_env = adsr_at(&p->car, t, gate);
            float mod_env = adsr_at(&p->mod, t, gate);
            float amount = p->mod.index_env_amount;
            float follow = (1.0f - amount) * mod_env + amount * amp_env;
            float index = p->mod.index * p->mod.level * follow;
            if (index < 0.0f) index = 0.0f;
            if (p->lfo_target == LFO_INDEX) index *= fmaxf(0.0f, 1.0f + p->lfo_depth * lfo);
            if (v == 0 && index0) index0[i] = index;

            float mod_s = sinf(two_pi * (float)mod_phase[v]) * index;
            float amp = amp_env * p->car.level * (0.25f + 0.75f * p->notes[v].velocity);
            if (p->lfo_target == LFO_AMP) amp *= fmaxf(0.0f, 1.0f + p->lfo_depth * lfo);
            sum += sinf(two_pi * (float)car_phase[v] + mod_s) * amp;

            mod_phase[v] += (double)mod_hz / (double)sr;
            car_phase[v] += (double)car_hz / (double)sr;
            wrap_phase(&mod_phase[v]);
            wrap_phase(&car_phase[v]);
        }
        out[i] = tanhf(sum * p->gain);
    }
    return 0;
}

static void w16(FILE *f, unsigned v) {
    unsigned char b[2] = { (unsigned char)(v & 255), (unsigned char)((v >> 8) & 255) };
    fwrite(b, 1, 2, f);
}

static void w32(FILE *f, unsigned v) {
    unsigned char b[4] = {
        (unsigned char)(v & 255), (unsigned char)((v >> 8) & 255),
        (unsigned char)((v >> 16) & 255), (unsigned char)((v >> 24) & 255)
    };
    fwrite(b, 1, 4, f);
}

static int write_wav(const char *path, const float *audio, int frames, int sample_rate) {
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    unsigned data_bytes = (unsigned)frames * 2u;
    fwrite("RIFF", 1, 4, f);
    w32(f, 36u + data_bytes);
    fwrite("WAVEfmt ", 1, 8, f);
    w32(f, 16);
    w16(f, 1);
    w16(f, 1);
    w32(f, (unsigned)sample_rate);
    w32(f, (unsigned)sample_rate * 2u);
    w16(f, 2);
    w16(f, 16);
    fwrite("data", 1, 4, f);
    w32(f, data_bytes);
    for (int i = 0; i < frames; i++) {
        float y = audio[i];
        if (y > 1.0f) y = 1.0f;
        if (y < -1.0f) y = -1.0f;
        int s = (int)lrintf(y * 32767.0f);
        if (s > 32767) s = 32767;
        if (s < -32768) s = -32768;
        unsigned u = (unsigned)(s & 0xFFFF);
        w16(f, u);
    }
    int bad = ferror(f);
    if (fclose(f) != 0) return -1;
    return bad ? -1 : 0;
}

static char *read_file(const char *path, size_t *out_len, char *err, size_t errlen) {
    FILE *f = NULL;
    int stdin_mode = strcmp(path, "-") == 0;
    if (stdin_mode) f = stdin;
    else f = fopen(path, "rb");
    if (!f) {
        snprintf(err, errlen, "cannot open %s: %s", path, strerror(errno));
        return NULL;
    }
    size_t cap = 4096, n = 0;
    char *buf = malloc(cap);
    if (!buf) {
        if (!stdin_mode) fclose(f);
        snprintf(err, errlen, "out of memory");
        return NULL;
    }
    while (!feof(f)) {
        if (n + 2048 > cap) {
            if (cap > 1024 * 1024) {
                free(buf);
                if (!stdin_mode) fclose(f);
                snprintf(err, errlen, "patch exceeds 1MB");
                return NULL;
            }
            cap *= 2;
            char *grown = realloc(buf, cap);
            if (!grown) {
                free(buf);
                if (!stdin_mode) fclose(f);
                snprintf(err, errlen, "out of memory");
                return NULL;
            }
            buf = grown;
        }
        size_t got = fread(buf + n, 1, cap - n - 1, f);
        n += got;
        if (got == 0) break;
    }
    if (!stdin_mode) fclose(f);
    buf[n] = 0;
    *out_len = n;
    return buf;
}

static int emit_error(const char *msg) {
    fprintf(stderr, "%s\n", msg);
    printf("{\"status\":\"error\",\"msg\":\"%s\"}\n", msg);
    return 1;
}

static int cmd_render(int argc, char **argv) {
    const char *out_path = NULL;
    const char *in_path = NULL;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) out_path = argv[++i];
        else if (!in_path) in_path = argv[i];
        else return emit_error("usage: vibe-fm render -o out.wav patch.json");
    }
    if (!out_path || !in_path) return emit_error("usage: vibe-fm render -o out.wav patch.json");

    char err[160];
    size_t len = 0;
    char *text = read_file(in_path, &len, err, sizeof err);
    if (!text) return emit_error(err);

    Arena arena = { malloc(256 * 1024), 0, 256 * 1024 };
    if (!arena.base) {
        free(text);
        return emit_error("out of memory");
    }
    JVal *root = json_parse(text, len, &arena, err, sizeof err);
    free(text);
    if (!root) {
        free(arena.base);
        return emit_error(err);
    }
    Patch patch;
    if (load_patch(root, &patch, err, sizeof err) != 0) {
        free(arena.base);
        return emit_error(err);
    }
    free(arena.base);

    int frames = (int)llround((double)patch.duration_s * (double)patch.sample_rate);
    float *audio = calloc((size_t)frames, sizeof *audio);
    if (!audio) return emit_error("out of memory");
    if (render_patch(&patch, audio, frames, NULL) != 0) {
        free(audio);
        return emit_error("render failed");
    }
    float peak = 0;
    for (int i = 0; i < frames; i++) {
        float a = fabsf(audio[i]);
        if (a > peak) peak = a;
    }
    if (write_wav(out_path, audio, frames, (int)patch.sample_rate) != 0) {
        free(audio);
        return emit_error("cannot write wav");
    }
    free(audio);
    printf("{\"status\":\"ok\",\"path\":\"%s\",\"frames\":%d,\"sample_rate\":%d,"
           "\"channels\":1,\"duration_s\":%.6f,\"seed\":%u,\"peak\":%.6f}\n",
           out_path, frames, (int)patch.sample_rate,
           (double)frames / (double)patch.sample_rate, patch.seed, peak);
    return 0;
}

static int g_fails = 0;

static void check(int cond, const char *msg) {
    if (cond) printf("ok %s\n", msg);
    else {
        fprintf(stderr, "FAIL %s\n", msg);
        g_fails++;
    }
}

static double mean_range(const float *x, int a, int b) {
    double acc = 0;
    int n = b - a;
    if (n < 1) return 0;
    for (int i = a; i < b; i++) acc += x[i];
    return acc / n;
}

static double rms_of(const float *x, int n) {
    double acc = 0;
    for (int i = 0; i < n; i++) acc += (double)x[i] * (double)x[i];
    return sqrt(acc / n);
}

static void brass_patch(Patch *p) {
    memset(p, 0, sizeof *p);
    p->duration_s = 0.5f;
    p->gain = 0.35f;
    p->sample_rate = 48000;
    p->seed = 7;
    p->nnotes = 3;
    p->notes[0] = (Note){60, 0.95f};
    p->notes[1] = (Note){64, 0.9f};
    p->notes[2] = (Note){67, 0.88f};
    p->mod.ratio = 1;
    p->mod.index = 5;
    p->mod.index_env_amount = 1;
    p->mod.attack = 0.001f;
    p->mod.decay = 0.001f;
    p->mod.sustain = 1;
    p->mod.release = 0.05f;
    p->mod.level = 1;
    p->car.ratio = 1;
    p->car.attack = 0.2f;
    p->car.decay = 0.05f;
    p->car.sustain = 1;
    p->car.release = 0.05f;
    p->car.level = 1;
    p->lfo_target = LFO_OFF;
}

static int self_test(void) {
    const char *fixture =
        "{"
        "\"duration_s\":0.5,\"gain\":0.35,\"seed\":7,\"sample_rate\":48000,"
        "\"notes\":[{\"midi\":60,\"velocity\":0.95},{\"midi\":64,\"velocity\":0.9},{\"midi\":67,\"velocity\":0.88}],"
        "\"modulator\":{\"ratio\":1,\"detune_cents\":0,\"index\":4.5,\"index_env_amount\":1,"
        "\"attack\":0.01,\"decay\":0.08,\"sustain\":0.4,\"release\":0.12,\"level\":1},"
        "\"carrier\":{\"ratio\":1,\"detune_cents\":3,\"attack\":0.02,\"decay\":0.1,\"sustain\":0.55,\"release\":0.15,\"level\":0.9},"
        "\"lfo\":{\"rate_hz\":5,\"depth\":0.08,\"target\":\"pitch\"}"
        "}";
    Arena arena = { malloc(256 * 1024), 0, 256 * 1024 };
    char err[160] = "";
    JVal *root = json_parse(fixture, strlen(fixture), &arena, err, sizeof err);
    check(root != NULL, "parse fixture");
    Patch parsed;
    int loaded = root ? load_patch(root, &parsed, err, sizeof err) : -1;
    check(loaded == 0, "load fixture");
    check(loaded == 0 && parsed.nnotes == 3, "three notes");
    check(loaded == 0 && parsed.mod.index_env_amount == 1.0f, "index follows amp envelope flag");
    check(loaded == 0 && parsed.seed == 7, "seed stored");

    char err2[160];
    Arena arena2 = { malloc(4096), 0, 4096 };
    JVal *bad = json_parse("{}", 2, &arena2, err2, sizeof err2);
    Patch junk;
    check(bad && load_patch(bad, &junk, err2, sizeof err2) != 0, "reject empty object");

    const int frames = (int)llround(0.5 * 48000.0);
    check(frames == 24000, "0.50s is 24000 frames at 48 kHz");
    float *a = calloc((size_t)frames, sizeof *a);
    float *b = calloc((size_t)frames, sizeof *b);
    float *idx = calloc((size_t)frames, sizeof *idx);
    check(a && b && idx, "buffers");

    if (loaded == 0 && a && b) {
        render_patch(&parsed, a, frames, NULL);
        render_patch(&parsed, b, frames, NULL);
        check(memcmp(a, b, (size_t)frames * sizeof *a) == 0, "same patch and seed match");
        parsed.seed = 8;
        render_patch(&parsed, b, frames, NULL);
        check(memcmp(a, b, (size_t)frames * sizeof *a) != 0, "different seed changes audio");
        check(rms_of(a, frames) > 0.02, "fixture is not silent");
    }

    Patch brass;
    brass_patch(&brass);
    if (a && idx) {
        render_patch(&brass, a, frames, idx);
        double early = mean_range(idx, 0, 960);
        double mid = mean_range(idx, 10560, 14400);
        check(early < 1.0 && mid > 4.0, "index rises with the amp envelope");
        brass.mod.index_env_amount = 0;
        render_patch(&brass, a, frames, idx);
        double early_flat = mean_range(idx, 480, 960);
        check(early_flat > 4.0, "amount 0 keeps the index up during a slow amp attack");
    }

    if (a && b) {
        brass_patch(&brass);
        brass.car.attack = 0.01f;
        render_patch(&brass, a, frames, NULL);
        brass.nnotes = 1;
        render_patch(&brass, b, frames, NULL);
        check(memcmp(a, b, (size_t)frames * sizeof *a) != 0, "three voices differ from one");
        check(rms_of(a, frames) > rms_of(b, frames), "three voices are louder than one");
        brass.gain = 0;
        brass.nnotes = 3;
        render_patch(&brass, a, frames, NULL);
        int silent = 1;
        for (int i = 0; i < frames; i++) if (a[i] != 0.0f) silent = 0;
        check(silent, "zero gain is silent");
    }

    if (loaded == 0 && a) {
        parsed.seed = 7;
        render_patch(&parsed, a, frames, NULL);
        const char *path = "/tmp/vibe-fm-self.wav";
        check(write_wav(path, a, frames, 48000) == 0, "write wav");
        FILE *f = fopen(path, "rb");
        unsigned char hdr[44];
        size_t got = f ? fread(hdr, 1, 44, f) : 0;
        unsigned data_bytes = 0;
        if (got == 44) {
            data_bytes = (unsigned)hdr[40] | ((unsigned)hdr[41] << 8) |
                         ((unsigned)hdr[42] << 16) | ((unsigned)hdr[43] << 24);
        }
        check(got == 44 && memcmp(hdr, "RIFF", 4) == 0 && data_bytes == 48000, "wav is 0.50s mono 16-bit");
        if (f) fclose(f);
        remove(path);
    }

    free(a);
    free(b);
    free(idx);
    free(arena.base);
    free(arena2.base);
    if (g_fails) {
        fprintf(stderr, "%d checks failed\n", g_fails);
        return 1;
    }
    printf("{\"status\":\"ok\",\"checks\":\"self-test\"}\n");
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "self-test") == 0) return self_test();
    if (argc >= 2 && strcmp(argv[1], "render") == 0) return cmd_render(argc, argv);
    fprintf(stderr, "usage: vibe-fm render -o out.wav patch.json\n       vibe-fm self-test\n");
    return 2;
}
