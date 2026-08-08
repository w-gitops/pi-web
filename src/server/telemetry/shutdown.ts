export async function boundedTelemetryShutdown(shutdown: () => Promise<void>, timeoutMillis: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMillis);
    timer.unref();
  });
  try {
    await Promise.race([shutdown().catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
