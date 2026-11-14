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
node src/dsp-self-check.mjs
node src/server.mjs
```

Open `http://10.1.1.106:3920/`.

The boot service is `systemd/user/gumbo-kitchen.service`. This account has linger enabled, so the user manager starts it at boot. It reads the wordfactory env file and listens on port 3920.

```bash
ln -sfn /home/snerloc/vibe-hub/gumbo-kitchen/systemd/user/gumbo-kitchen.service \
  ~/.config/systemd/user/gumbo-kitchen.service
systemctl --user daemon-reload
systemctl --user enable --now gumbo-kitchen.service
```
