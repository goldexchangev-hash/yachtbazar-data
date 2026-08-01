# YachtBazar catalog data

Data releases for [yachtbazar.com](https://yachtbazar.com) — a marina, dock and
boat catalog. The release assets (`catalog.tar.gz`, `data-snapshot*.tar.gz`,
`data-delta*.tar.gz`) contain `listings.js` / `listings.json` / `data.db` plus a
`licenses/` folder carrying the attribution notice and full licence texts.

## Attribution and licensing

Records in this catalog come from several sources under different licences.
Each record carries a `source` field (marina records additionally an
`import_src` field) identifying where it came from.

**OpenStreetMap-derived records** (`source: "osm"`, and `import_src: "osm-delta"`):
Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
These records, and any database derived from them, are distributed under the
ODbL 1.0. Each such record retains a link or id identifying its OpenStreetMap
object. City values on these records were produced with OSM's Nominatim.

**Overture-derived records** (`import_src: "overture"`): derived from the
[Overture Maps Foundation](https://overturemaps.org) Places theme (accessed
2026-07-29), used under CDLA-Permissive-2.0 / Apache-2.0 (Foursquare-sourced
records — Copyright 2024 Foursquare Labs, Inc.) / CC0-1.0 depending on the
record's original source. Modified by YachtBazar: fields selected, reformatted
and normalised. Full licence texts ship inside each release asset.

**Other records** are compiled by YachtBazar from marina operators' own public
websites and public by-owner listing sources, or posted directly by owners.

See `LICENSE` and the `licenses/` folder inside each release asset for the
complete notices.
