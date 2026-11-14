# Gumbo's Kitchen

LLM control plane for the vibe-hub apps. A prompt goes to local qwen, the reply is checked against the module schema, and the engine writes a WAV. FM renders use `engine/vibe-fm`. Sampler and sequencer renders use `engine/dsp.mjs`. The shared catalogue is Postgres schema `vibe` in the `wordfactory` database. That schema name stays. This repo is the control plane, not a rename of the catalogue.

The composition page slices, granulates, layers, and mixes. Each of those writes a new sample. `parent_id` points at the input.

Remote: https://github.com/bludclotau/gumbo-kitchen.git

The contract is `docs/module-contract.md`.

```bash
cd /home/snerloc/vibe-hub/gumbo-kitchen
make -C engine test
npm install
set -a && source ../cyberrave-wordfactory/.env && set +a
node src/migrate.mjs
node src/import-wavbvkery.mjs
node src/self-check.mjs
node src/dsp-self-check.mjs
node src/reproduce-check.mjs --n 4
node src/server.mjs
```

Open `http://10.1.1.106:3920/`.

The boot service is `systemd/user/gumbo-kitchen.service`. This account has linger enabled, so the user manager starts it at boot. It reads the wordfactory env file and this repo's gitignored `.env`, which holds `VIBE_QWEN_URL`, `VIBE_QWEN_MODEL`, `VIBE_DOLPHIN_URL`, and `VIBE_DOLPHIN_MODEL`. It listens on port 3920.

```bash
ln -sfn /home/snerloc/vibe-hub/gumbo-kitchen/systemd/user/gumbo-kitchen.service \
  ~/.config/systemd/user/gumbo-kitchen.service
systemctl --user daemon-reload
systemctl --user enable --now gumbo-kitchen.service
```

## How a prompt flows

`src/router.mjs` is a rule. It does not call a model.

- A concrete command goes to qwen. That is a timed instrument, a numbered sampler operation, a tempo, a layer, or a mix. Qwen returns schema-validated JSON.
- A descriptive or underspecified request goes to dolphin first. Dolphin rewrites it as one concrete instruction. Qwen then returns the JSON. The sample keeps the user's original prompt.
- A request for a lyric, a name, or tags goes to dolphin only. The text is stored on `vibe.lyrics` and no WAV is rendered.

Each call is a `vibe.llm_calls` row with the model, the node, the attempt, the error, the latency, and the job. A failed check is sent back with the validator text, up to three tries. The third failure marks the job failed.

The engine renders offline from the validated document and the seed. The sample row stores that patch, the seed, and the engine version (`vibe-fm 1` or `dsp 1`). `npm run reproduce-check` re-renders random rows from that record and compares WAV hashes.
