export function isFatalTransport(message) {
  const text = String(message || "");
  if (/HTTP 400/i.test(text)) return false;
  return /timeout|aborted|ECONNREFUSED/i.test(text);
}

export async function withValidationRetries({ attempts = 3, call, check, noteError }) {
  let lastError = "no attempt";
  let previous = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let callId = null;
    try {
      const result = await call({ attempt, lastError, previous });
      previous = String(result?.text || "");
      callId = result?.id ?? null;
      return await check(previous, attempt);
    } catch (err) {
      lastError = String(err?.message || err).slice(0, 800);
      const id = err?.callId ?? callId;
      if (id && noteError) {
        try {
          await noteError(id, lastError);
        } catch (logErr) {
          console.error("failed to record llm error", logErr.message);
        }
      }
      if (attempt === attempts || isFatalTransport(lastError)) throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}
