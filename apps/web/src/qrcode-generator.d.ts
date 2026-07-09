// Minimal typings for qrcode-generator (ships none). We use only the matrix.
declare module "qrcode-generator" {
  type QRCode = {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
  export default function qrcode(typeNumber: number, errorCorrection: "L" | "M" | "Q" | "H"): QRCode;
}
