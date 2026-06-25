export const formatNumber = (value) => {
  if (value === undefined || value === null) {
    return 'N/A';
  }

  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export const capitalize = (value = '') => {
  if (!value) {
    return '';
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
};

export const formatDuration = (milliseconds) => {
  if (!milliseconds && milliseconds !== 0) {
    return 'N/A';
  }

  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000)
    .toString()
    .padStart(2, '0');

  return `${minutes}:${seconds}`;
};
