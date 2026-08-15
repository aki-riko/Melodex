export function formatDuration(value) {
  if (value === undefined || value === null || value === '') {
    return 'N/A';
  }

  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'N/A';
  }

  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
