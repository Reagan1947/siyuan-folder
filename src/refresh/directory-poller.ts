const MIN_INTERVAL_MS = 2000;

export class DirectoryPoller {
    private timer = 0;
    private running = false;
    private stopped = true;

    constructor(
        private readonly refresh: () => Promise<void>,
        private readonly intervalMs: number | (() => number),
        private readonly isActive: () => boolean,
    ) {}

    start(): void {
        this.stop();
        this.stopped = false;
        this.schedule();
    }

    stop(): void {
        this.stopped = true;
        window.clearTimeout(this.timer);
        this.timer = 0;
    }

    private schedule(): void {
        const requested = typeof this.intervalMs === "function" ? this.intervalMs() : this.intervalMs;
        const delay = Math.max(MIN_INTERVAL_MS, requested);
        this.timer = window.setTimeout(() => {
            void this.tick();
        }, delay);
    }

    private async tick(): Promise<void> {
        if (this.stopped) {
            return;
        }
        if (!this.running && this.isActive()) {
            this.running = true;
            try {
                await this.refresh();
            } finally {
                this.running = false;
            }
        }
        if (!this.stopped) {
            this.schedule();
        }
    }
}
