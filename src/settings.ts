export const MIN_POLL_SECONDS = 2;
export const MAX_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 3;
export const SETTINGS_STORAGE = "settings";

let seconds = DEFAULT_POLL_SECONDS;

export function clampPollSeconds(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_POLL_SECONDS;
    }
    return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(value)));
}

export function pollIntervalSeconds(): number {
    return seconds;
}

export function pollIntervalMs(): number {
    return seconds * 1000;
}

export function setPollIntervalSeconds(value: number): number {
    seconds = clampPollSeconds(value);
    return seconds;
}
