/**
 * global.d.ts
 * Declares global types for process.env variables injected by Vite's define block.
 */
declare var process: {
  env: {
    [key: string]: string;
  };
};
