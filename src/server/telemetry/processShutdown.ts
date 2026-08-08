export async function boundedProcessShutdown(runOrderedShutdown: () => Promise<void>, timeoutMillis = 8_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMillis);
    timer.unref();
  });
  try {
    await Promise.race([runOrderedShutdown().catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
