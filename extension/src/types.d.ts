/** The Shape Detection API, which Chrome on macOS ships but TypeScript's DOM library does not describe. */
declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(source: ImageBitmapSource): Promise<{ rawValue: string; format: string }[]>;
}
