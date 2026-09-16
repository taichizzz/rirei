for (const key of Object.keys(process.env)) {
  if (key.startsWith('RIREI_') && key !== 'RIREI_DATA_HOME') {
    delete process.env[key];
  }
}
