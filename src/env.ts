// Configuration, read once and refused loudly.
//
// A missing variable should name itself at the moment it is missing. The failure
// this replaces is a half-configured app that starts, serves, and then produces
// something that looks like a database problem three requests later.

export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const required = (name: string, why?: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new ConfigError(
      name,
      `${name} is not set.${why ? ` ${why}` : ''} The SDK refuses to start on a ` +
        `half-configured environment rather than failing later with something that ` +
        `looks like a different problem.`,
    );
  }
  return value;
};

export const optional = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};
