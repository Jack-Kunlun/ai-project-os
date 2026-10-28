/** Read SOF dimensions without retaining APP/COM payloads of arbitrary size. */
export class JpegHeaderReader {
  dimensions: readonly [number, number] | undefined;
  private state: "soi" | "markerStart" | "marker" | "lengthHigh" | "lengthLow" | "body" | "done" = "soi";
  private soiBytes = 0;
  private marker = 0;
  private length = 0;
  private remaining = 0;
  private sof: number[] = [];

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length && this.state !== "done") {
      if (this.state === "body" && !(this.marker >= 0xc0 && this.marker <= 0xc3)) {
        const skipped = Math.min(this.remaining, chunk.length - offset);
        offset += skipped;
        this.remaining -= skipped;
        if (this.remaining === 0) this.state = "markerStart";
        continue;
      }
      const byte = chunk[offset++]!;
      switch (this.state) {
        case "soi":
          if (byte !== (this.soiBytes === 0 ? 0xff : 0xd8)) { this.state = "done"; break; }
          if (++this.soiBytes === 2) this.state = "markerStart";
          break;
        case "markerStart": this.state = byte === 0xff ? "marker" : "done"; break;
        case "marker":
          if (byte === 0xff) break; // Legal marker fill bytes.
          if (byte === 0 || byte === 0xda || byte === 0xd9) { this.state = "done"; break; }
          this.marker = byte;
          this.state = "lengthHigh";
          break;
        case "lengthHigh": this.length = byte << 8; this.state = "lengthLow"; break;
        case "lengthLow":
          this.length += byte;
          this.remaining = this.length - 2;
          if (this.remaining < 0 || (this.marker >= 0xc0 && this.marker <= 0xc3 && this.length < 11)) { this.state = "done"; break; }
          this.sof = [];
          this.state = this.remaining === 0 ? "markerStart" : "body";
          break;
        case "body":
          if (this.sof.length < 6) this.sof.push(byte);
          if (this.sof.length === 6 && (this.sof[5] === 0 || this.length !== 8 + 3 * this.sof[5]!)) {
            this.state = "done";
            break;
          }
          this.remaining -= 1;
          if (this.remaining === 0) {
            if (this.sof.length === 6) this.dimensions = [(this.sof[3]! << 8) | this.sof[4]!, (this.sof[1]! << 8) | this.sof[2]!];
            this.state = "done";
          }
          break;
      }
    }
  }
}
