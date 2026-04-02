import logger from './logger.js';

async function disposeBrowserService() {
    try {
        const { disposeBrowserService } = await import("./browser/BrowserService.ts");
        await disposeBrowserService();
    } catch (_) {
        // BrowserService may be unavailable before playwright dependencies are installed.
    }
}

// 允许无限量的监听器
process.setMaxListeners(Infinity);
// 输出未捕获异常
process.on("uncaughtException", (err, origin) => {
    logger.error(`An unhandled error occurred: ${origin}`, err);
});
// 输出未处理的Promise.reject
process.on("unhandledRejection", (_, promise) => {
    promise.catch(err => logger.error("An unhandled rejection occurred:", err));
});
// 输出系统警告信息
process.on("warning", warning => logger.warn("System warning: ", warning));
// 进程退出监听
process.on("exit", () => {
    logger.info("Service exit");
    logger.footer();
});
// 进程被kill
process.on("SIGTERM", () => {
    logger.warn("received kill signal");
    void disposeBrowserService().finally(() => process.exit(0));
});
// Ctrl-C进程退出
process.on("SIGINT", () => {
    void disposeBrowserService().finally(() => process.exit(0));
});
