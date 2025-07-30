export const exportToCSV = (data, columns) => {
  const escapeCsvValue = (value) => {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = columns.map((col) => escapeCsvValue(col.label)).join(',');
  const rows = data.map((row) =>
    columns.map((col) => escapeCsvValue(col.value(row))).join(',')
  );

  return [headers, ...rows].join('\n');
};
