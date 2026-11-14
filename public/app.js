const form = document.querySelector("#prompt-form");
const promptEl = document.querySelector("#prompt");
const errorEl = document.querySelector("#form-error");
const compForm = document.querySelector("#comp-form");
const compPrompt = document.querySelector("#comp-prompt");
const compError = document.querySelector("#comp-error");
const compMeta = document.querySelector("#comp-meta");
const compChain = document.querySelector("#comp-chain");
const layersEl = document.querySelector("#layers");
const playMix = document.querySelector("#play-mix");
const jobsEl = document.querySelector("#jobs");
const samplesEl = document.querySelector("#samples");
const filterEl = document.querySelector("#filter");
const player = document.querySelector("#player");

let compId = null;
let mixUrl = "";

function play(url) {
  player.src = url;
  player.play().catch(() => {
    const message = "The browser blocked playback. Press play on the bar.";
    errorEl.textContent = message;
    compError.textContent = message;
  });
}

function jobItem(job) {
  const li = document.createElement("li");
  const text = document.createElement("div");
  const status = document.createElement("div");
  status.className = `status${job.status === "failed" ? " failed" : ""}`;
  status.textContent = job.status;
  const prompt = document.createElement("p");
  prompt.className = "prompt";
  prompt.textContent = job.prompt;
  text.append(status, prompt);
  if (job.sample) {
    const meta = document.createElement("p");
    meta.className = "meta";
    const tags = (job.sample.tags || []).join(", ");
    meta.textContent = `${Number(job.sample.duration_s).toFixed(2)}s · ${tags}`;
    text.append(meta);
  }
  if (job.error) {
    const err = document.createElement("p");
    err.className = "meta";
    err.textContent = job.error;
    text.append(err);
  }
  li.append(text);
  if (job.sample) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "play";
    button.textContent = "Play";
    button.addEventListener("click", () => play(job.sample.url));
    li.append(button);
  }
  return li;
}

function sampleItem(sample) {
  const li = document.createElement("li");
  const text = document.createElement("div");
  const name = document.createElement("p");
  name.className = "prompt";
  name.textContent = sample.name;
  const meta = document.createElement("p");
  meta.className = "tags";
  const bits = [sample.source, `${Number(sample.duration_s).toFixed(2)}s`, ...(sample.tags || [])];
  if (sample.key) bits.push(sample.key);
  if (sample.parent_id) bits.push(`parent ${sample.parent_id}`);
  meta.textContent = bits.join(" · ");
  text.append(name, meta);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "play";
  button.textContent = "Play";
  button.addEventListener("click", () => play(sample.url));
  li.append(text, button);
  return li;
}

function fill(list, items, render, empty) {
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = empty;
    list.append(li);
    return;
  }
  for (const item of items) list.append(render(item));
}

function layerItem(layer) {
  const li = document.createElement("li");
  const text = document.createElement("div");
  const name = document.createElement("p");
  name.className = "prompt";
  name.textContent = `Layer ${layer.position + 1}`;
  const meta = document.createElement("p");
  meta.className = "tags";
  const side = layer.pan < -0.05 ? "left" : layer.pan > 0.05 ? "right" : "centre";
  const bits = [`gain ${Number(layer.gain).toFixed(2)}`, side];
  if (layer.steps) bits.push(`${layer.steps} steps`);
  if (layer.sample_name) bits.push(layer.sample_name);
  meta.textContent = bits.join(" · ");
  text.append(name, meta);
  li.append(text);
  if (layer.audio) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "play";
    button.textContent = "Play";
    button.addEventListener("click", () => play(layer.audio));
    li.append(button);
  }
  return li;
}

function showComposition(composition) {
  if (!composition) {
    compId = null;
    mixUrl = "";
    compMeta.textContent = "No composition yet.";
    compChain.textContent = "";
    playMix.disabled = true;
    fill(layersEl, [], layerItem, "No layers yet.");
    return;
  }
  compId = composition.id;
  const key = composition.key || "no key";
  const mix = composition.mixdown
    ? `mixdown ${Number(composition.mixdown.duration_s).toFixed(2)}s`
    : "no mixdown yet";
  compMeta.textContent = `${composition.title} · ${Number(composition.bpm)} bpm · ${key} · ${mix}`;
  compChain.textContent = composition.chain && composition.chain.length
    ? `parent chain ${composition.chain.join(" → ")}`
    : "";
  mixUrl = composition.mixdown ? composition.mixdown.url : "";
  playMix.disabled = !mixUrl;
  fill(layersEl, composition.layers, layerItem, "No layers yet.");
}

let timer = 0;

async function refresh() {
  const params = new URLSearchParams();
  if (filterEl.value.trim()) params.set("q", filterEl.value.trim());
  const compositionUrl = compId ? `/api/composition?id=${compId}` : "/api/composition";
  const [jobsRes, samplesRes, compRes] = await Promise.all([
    fetch("/api/jobs"),
    fetch(`/api/samples?${params}`),
    fetch(compositionUrl),
  ]);
  if (!jobsRes.ok || !samplesRes.ok || !compRes.ok) throw new Error("list failed");
  const jobs = await jobsRes.json();
  const samples = await samplesRes.json();
  const composition = await compRes.json();
  fill(jobsEl, jobs.jobs, jobItem, "No jobs yet.");
  fill(samplesEl, samples.samples, sampleItem, "No samples match.");
  showComposition(composition.composition);
  const busy = jobs.jobs.some((job) => job.status === "pending" || job.status === "running");
  clearTimeout(timer);
  timer = setTimeout(refresh, busy ? 1000 : 5000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptEl.value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not queue the job");
    await refresh();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

playMix.addEventListener("click", () => {
  if (mixUrl) play(mixUrl);
});

compForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  compError.textContent = "";
  const button = compForm.querySelector("button");
  button.disabled = true;
  try {
    if (!compId) {
      const created = await fetch("/api/compositions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Kitchen" }),
      });
      const createdBody = await created.json();
      if (!created.ok) throw new Error(createdBody.error || "could not open a composition");
      compId = createdBody.composition.id;
    }
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: compPrompt.value,
        module: "sampler",
        composition_id: compId,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not queue the job");
    await refresh();
  } catch (err) {
    compError.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

filterEl.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 200);
});

refresh().catch((err) => {
  errorEl.textContent = err.message;
});
