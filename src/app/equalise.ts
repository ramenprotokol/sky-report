/**
 * Histogram equalisation of the cloud noise volume. After it, every channel's values are spread
 * evenly over [0, 1] within each horizontal slice, so "keep the top c of the noise" covers a
 * fraction c of any horizontal plane through a layer. Equalising the whole volume at once is not
 * enough: the low-frequency channel has only a few blobs per slice, so one slice (which is what a
 * layer at one height samples) can be far from even. Pure, unit-tested.
 */
export function equaliseSlices(data: Uint8Array, voxelsPerSlice: number): void {
  const stride = voxelsPerSlice * 4;
  if (stride <= 0 || data.length % stride !== 0) throw new Error('equaliseSlices: data is not a whole number of slices');
  const hist = new Uint32Array(256);
  const lut = new Uint8Array(256);
  for (let start = 0; start < data.length; start += stride) {
    const end = start + stride;
    for (let c = 0; c < 4; c++) {
      hist.fill(0);
      for (let i = start + c; i < end; i += 4) hist[data[i]!]! += 1;
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        const h = hist[v]!;
        // Map each value to the middle of its rank range.
        lut[v] = Math.min(255, Math.round(((acc + h / 2) / voxelsPerSlice) * 255));
        acc += h;
      }
      for (let i = start + c; i < end; i += 4) data[i] = lut[data[i]!]!;
    }
  }
}
