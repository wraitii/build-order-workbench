export function formatMMSS(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    const sec = whole % 60;
    return `${String(minutes).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
