// Era captions shown while scrubbing/playing, with camera choreography for
// click-to-jump. Month indices count from Jan 1990 (m = (year-1990)*12 +
// month-1). Ranges must not overlap: the first match wins. Facts
// cross-checked against the HDB resale price index record and this dataset
// itself (the Mei Ling St sale and the 2024 million-dollar count are
// computed from data/out/transactions.bin).
//
// cam = [lon, lat, zoom, pitch, bearing]; at = month the jump lands on;
// select = postal code of a block to auto-select on jump.
export type Era = {
  from: number;
  to: number;
  title: string;
  sub: string;
  at: number;
  cam: [number, number, number, number, number];
  select?: string;
};

const ISLAND: Era["cam"] = [103.82, 1.352, 11.2, 55, -12];

export const EVENTS: Era[] = [
  {
    from: 36, to: 83, at: 60, cam: ISLAND, // 1993-01 – 1996-12
    title: "The early-90s boom",
    sub: "Prices rise 50% in six months of 1993 and triple by 1996",
  },
  {
    from: 90, to: 107, at: 100, cam: ISLAND, // 1997-07 – 1998-12
    title: "Asian Financial Crisis",
    sub: "Prices fall about 30% — and take a decade to recover",
  },
  {
    from: 108, to: 143, at: 138, cam: [103.9064, 1.4021, 12.6, 55, -12], // 1999-01 – 2001-12
    title: "A new northeast",
    sub: "Sengkang (1997) and Punggol (2000) rise from empty land",
  },
  {
    from: 156, to: 191, at: 172, cam: ISLAND, // 2003-01 – 2005-12
    title: "The long stagnation",
    sub: "Dot-com bust, then SARS — the market drifts for years",
  },
  {
    from: 228, to: 269, at: 252, cam: ISLAND, // 2009-01 – 2012-06
    title: "Post-GFC surge",
    sub: "Four years of records; cash-over-valuation peaks",
  },
  {
    from: 270, to: 281, at: 270, cam: [103.8045, 1.2949, 15.8, 60, 20], select: "140149", // 2012-07 – 2013-06
    title: "The first million-dollar flat",
    sub: "Blk 149 Mei Ling Street, Queenstown — exactly S$1,000,000",
  },
  {
    from: 282, to: 353, at: 318, cam: ISLAND, // 2013-07 – 2019-06
    title: "Cooling measures bite",
    sub: "MSR and TDSR end the boom — six years of slow decline",
  },
  {
    from: 366, to: 407, at: 390, cam: ISLAND, // 2020-07 – 2023-12
    title: "The COVID surge",
    sub: "BTO delays push buyers to resale — prices double in six years",
  },
  {
    from: 408, to: 438, at: 430, cam: [103.85, 1.33, 12.2, 55, -12], // 2024-01 –
    title: "Million-dollar flats go mainstream",
    sub: "1,035 flats crossed S$1m in 2024 alone",
  },
];
