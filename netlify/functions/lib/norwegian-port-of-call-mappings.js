/**
 * Norwegian Cruise Line — port-of-call code mappings (Phase 5C).
 * Extends embark mappings for schedule-page portsOfCall resolution.
 */

const NCL_PORT_OF_CALL_CODES = Object.freeze([
  { code: "MLA", source_name: "Valletta, Malta", canonical_name: "Valletta", classification: "NEW_PORT_REQUIRED", country: "Malta" },
  { code: "EPM", source_name: "Eastport, Maine", canonical_name: "Eastport", classification: "NEW_PORT_REQUIRED", country: "United States" },
  { code: "MOT", source_name: "Motril, Spain", canonical_name: "Motril", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "POP", source_name: "Puerto Plata, Dominican Republic", canonical_name: "Puerto Plata", classification: "NEW_PORT_REQUIRED", country: "Dominican Republic" },
  {
    code: "PWM",
    source_name: "Portland, Maine",
    canonical_name: "Portland Maine",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "United States",
    note: "Must not map to Portland, Oregon"
  },
  { code: "AKI", source_name: "Akita, Japan", canonical_name: "Akita", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "KZW", source_name: "Kanazawa, Japan", canonical_name: "Kanazawa", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "HKD", source_name: "Hakodate, Japan", canonical_name: "Hakodate", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "SMZ",
    source_name: "Mount Fuji (Shimizu), Japan",
    canonical_name: "Shimizu",
    classification: "EXISTING_ALIAS",
    country: "Japan",
    note: "Physical cruise port is Shimizu, not Mount Fuji"
  },
  {
    code: "BPI",
    source_name: "Harvest Caye, Belize",
    canonical_name: "Harvest Caye",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Belize",
    note: "NCL private destination — distinct from Belize City"
  },
  {
    code: "FMH",
    source_name: "Falmouth, Jamaica",
    canonical_name: "Falmouth Jamaica",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Jamaica",
    note: "Jamaica Falmouth — not Falmouth UK"
  },
  { code: "LGN", source_name: "La Goulette, Tunisia", canonical_name: "La Goulette", classification: "NEW_PORT_REQUIRED", country: "Tunisia" },
  {
    code: "FPO",
    source_name: "Grand Bahama Island, Bahamas",
    canonical_name: "Freeport",
    classification: "EXISTING_ALIAS",
    country: "Bahamas",
    note: "NCL label for Freeport/Grand Bahama cruise port"
  },
  { code: "SAM", source_name: "Samana, Dominican Republic", canonical_name: "Samana", classification: "NEW_PORT_REQUIRED", country: "Dominican Republic" },
  { code: "KOT", source_name: "Kotor, Montenegro", canonical_name: "Kotor", classification: "NEW_PORT_REQUIRED", country: "Montenegro" },
  {
    code: "WRF",
    source_name: "Royal Naval Dockyard, Bermuda",
    canonical_name: "Royal Naval Dockyard",
    classification: "NEW_PORT_REQUIRED",
    country: "Bermuda",
    note: "Bermuda cruise terminal at King's Wharf"
  },
  {
    code: "BAR",
    source_name: "Bar, Montenegro",
    canonical_name: "Bar",
    classification: "NEW_PORT_REQUIRED",
    country: "Montenegro",
    note: "Adriatic port Bar, Montenegro — not Bar ME abbreviation alone"
  },
  {
    code: "LEH",
    source_name: "Paris (Le Havre), France",
    canonical_name: "Le Havre",
    classification: "EXISTING_ALIAS",
    country: "France",
    note: "Marketing city Paris; physical port Le Havre"
  },
  {
    code: "ZEE",
    source_name: "Brussels / Bruges (Zeebrugge), Belgium",
    canonical_name: "Zeebrugge",
    classification: "NEW_PORT_REQUIRED",
    country: "Belgium"
  },
  { code: "MLY", source_name: "Maloy, Norway", canonical_name: "Maloy", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "SKJ", source_name: "Skjolden, Norway", canonical_name: "Skjolden", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "SAK", source_name: "Sakaiminato, Japan", canonical_name: "Sakaiminato", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "AOM", source_name: "Aomori, Japan", canonical_name: "Aomori", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "NGO", source_name: "Nagoya, Japan", canonical_name: "Nagoya", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "SDA",
    source_name: "Sendai (Ishinomaki), Japan",
    canonical_name: "Sendai",
    classification: "NEW_PORT_REQUIRED",
    country: "Japan",
    note: "Ishinomaki/Sendai region cruise port"
  },
  { code: "MAI", source_name: "Maizuru, Japan", canonical_name: "Maizuru", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "KOA",
    source_name: "Kona, Hawaii",
    canonical_name: "Kona",
    classification: "NEW_PORT_REQUIRED",
    country: "United States",
    note: "Hawaii convention — Kailua-Kona cruise port"
  },
  { code: "MLN", source_name: "Melillia, Spain", canonical_name: "Melilla", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  {
    code: "PSY",
    source_name: "Stanley, Falkland Islands",
    canonical_name: "Stanley",
    classification: "NEW_PORT_REQUIRED",
    country: "Falkland Islands",
    note: "Falkland Islands — disambiguated by country, not generic Stanley"
  },
  { code: "NPI", source_name: "Great Stirrup Cay, Bahamas", canonical_name: "Great Stirrup Cay", classification: "EXISTING_ALIAS", country: "Bahamas" },
  { code: "ACA", source_name: "Acapulco, Mexico", canonical_name: "Acapulco", classification: "NEW_PORT_REQUIRED", country: "Mexico" },
  { code: "PRQ", source_name: "Puerto Quetzal, Guatemala", canonical_name: "Puerto Quetzal", classification: "NEW_PORT_REQUIRED", country: "Guatemala" },
  {
    code: "PCL",
    source_name: "Puntarenas (Puerto Caldera), Costa Rica",
    canonical_name: "Puerto Caldera",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Costa Rica",
    note: "Physical cruise port is Puerto Caldera; Puntarenas is the regional/marketing label"
  },
  { code: "HOR", source_name: "Horta, Azores", canonical_name: "Horta", classification: "NEW_PORT_REQUIRED", country: "Portugal" },
  {
    code: "LXO",
    source_name: "Oporto, Portugal",
    canonical_name: "Leixoes",
    classification: "NEW_PORT_REQUIRED",
    country: "Portugal",
    note: "NCL LXO is Leixões cruise port; Oporto/Porto are marketing city labels"
  },
  {
    code: "AST",
    source_name: "Astoria, Oregon",
    canonical_name: "Astoria Oregon",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "United States",
    note: "US Pacific Northwest cruise port — not Astoria elsewhere"
  },
  { code: "BRI", source_name: "Bari, Italy", canonical_name: "Bari", classification: "NEW_PORT_REQUIRED", country: "Italy" },
  {
    code: "KCZ",
    source_name: "Kochi, Japan",
    canonical_name: "Kochi Japan",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Japan",
    note: "Japanese Kochi (Shikoku) — distinct from Cochin, India"
  },
  { code: "NAH", source_name: "Naha (Okinawa), Japan", canonical_name: "Naha", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "NII", source_name: "Niigata, Japan", canonical_name: "Niigata", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "CMY",
    source_name: "Chan May, Vietnam",
    canonical_name: "Chan May",
    classification: "EXISTING_ALIAS",
    country: "Vietnam",
    note: "Physical cruise port near Hue/Da Nang — Chan May already in catalogue"
  },
  {
    code: "HAN",
    source_name: "Hanoi (Ha Long Bay), Vietnam",
    canonical_name: "Halong Bay",
    classification: "EXISTING_ALIAS",
    country: "Vietnam",
    note: "Marketing Hanoi label; ships berth in Ha Long Bay area"
  },
  {
    code: "ESS",
    source_name: "Phillip Island, Australia",
    canonical_name: "Phillip Island",
    classification: "NEW_PORT_REQUIRED",
    country: "Australia"
  },
  {
    code: "DEN",
    source_name: "Denarau, Fiji",
    canonical_name: "Denarau",
    classification: "NEW_PORT_REQUIRED",
    country: "Fiji",
    note: "Port Denarau / Denarau Marina cruise gateway"
  },
  { code: "SVU", source_name: "Savusavu, Fiji", canonical_name: "Savusavu", classification: "NEW_PORT_REQUIRED", country: "Fiji" },
  { code: "DRA", source_name: "Dravuni, Fiji", canonical_name: "Dravuni", classification: "NEW_PORT_REQUIRED", country: "Fiji" },
  { code: "NPO", source_name: "Newport, Rhode Island", canonical_name: "Newport Rhode Island", classification: "NEW_PORT_REQUIRED", country: "United States", note: "New England cruise port — not Newport UK/Wales" },
  { code: "BHB", source_name: "Bar Harbor, Maine", canonical_name: "Bar Harbor", classification: "NEW_PORT_REQUIRED", country: "United States" },
  { code: "CBR", source_name: "Cabo Rojo, Dominican Republic", canonical_name: "Cabo Rojo", classification: "NEW_PORT_REQUIRED", country: "Dominican Republic" },
  { code: "ISH", source_name: "Ishigaki, Japan", canonical_name: "Ishigaki", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "JJU", source_name: "Jeju, South Korea", canonical_name: "Jeju", classification: "NEW_PORT_REQUIRED", country: "South Korea" },
  { code: "HK1", source_name: "Hakata (Fukuoka), Japan", canonical_name: "Fukuoka", classification: "NEW_PORT_REQUIRED", country: "Japan", note: "Hakata is the physical cruise terminal serving Fukuoka" },
  { code: "MAT", source_name: "Matsuyama, Japan", canonical_name: "Matsuyama", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "KAN", source_name: "Kangaroo Island, Australia", canonical_name: "Kangaroo Island", classification: "NEW_PORT_REQUIRED", country: "Australia", note: "Penneshaw / Kangaroo Island cruise anchorage" },
  { code: "RIX", source_name: "Riga, Latvia", canonical_name: "Riga", classification: "NEW_PORT_REQUIRED", country: "Latvia" },
  { code: "KLJ", source_name: "Klaipeda, Lithuania", canonical_name: "Klaipeda", classification: "NEW_PORT_REQUIRED", country: "Lithuania" },
  { code: "GDY", source_name: "Gdynia, Poland", canonical_name: "Gdynia", classification: "NEW_PORT_REQUIRED", country: "Poland" },
  { code: "PRM", source_name: "Portimão, Portugal", canonical_name: "Portimao", classification: "NEW_PORT_REQUIRED", country: "Portugal" },
  { code: "BE9", source_name: "Beppu, Japan", canonical_name: "Beppu", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "LBI", source_name: "Saguenay (La Baie), Québec", canonical_name: "Saguenay", classification: "NEW_PORT_REQUIRED", country: "Canada", note: "La Baie cruise terminal — not Quebec City" },
  { code: "RNN", source_name: "Ronne, Bornholm, Denmark", canonical_name: "Ronne Bornholm", classification: "NEW_PORT_REQUIRED", country: "Denmark" },
  { code: "RJK", source_name: "Rijeka, Croatia", canonical_name: "Rijeka", classification: "NEW_PORT_REQUIRED", country: "Croatia" },
  { code: "VIS", source_name: "Vik, Norway", canonical_name: "Vik Norway", classification: "NEW_PORT_REQUIRED", country: "Norway", note: "Vik in Sogn — distinct from Visby (VBY)" },
  { code: "MIY", source_name: "Miyakojima (Okinawa), Japan", canonical_name: "Miyakojima", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "SAS", source_name: "Sasebo, Japan", canonical_name: "Sasebo", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "MUA", source_name: "Muara, Brunei Darussalam", canonical_name: "Muara", classification: "NEW_PORT_REQUIRED", country: "Brunei" },
  { code: "KKB", source_name: "Kota Kinabalu, Malaysia", canonical_name: "Kota Kinabalu", classification: "NEW_PORT_REQUIRED", country: "Malaysia" },
  { code: "PPS", source_name: "Puerto Princesa, Philippines", canonical_name: "Puerto Princesa", classification: "NEW_PORT_REQUIRED", country: "Philippines" },
  { code: "COR", source_name: "Coron, Philippines", canonical_name: "Coron", classification: "NEW_PORT_REQUIRED", country: "Philippines" },
  { code: "VBY", source_name: "Visby, Sweden", canonical_name: "Visby", classification: "NEW_PORT_REQUIRED", country: "Sweden" },
  { code: "LPA", source_name: "Las Palmas, Canary Islands", canonical_name: "Las Palmas", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "SPU", source_name: "Split, Croatia", canonical_name: "Split", classification: "NEW_PORT_REQUIRED", country: "Croatia" },
  { code: "SCT", source_name: "Santa Cruz de Tenerife, Canary Islands", canonical_name: "Santa Cruz de Tenerife", classification: "NEW_PORT_REQUIRED", country: "Spain", note: "Distinct from Santa Cruz de la Palma (SCP)" },
  { code: "PTG", source_name: "Porto Grande, Cape Verde", canonical_name: "Porto Grande", classification: "NEW_PORT_REQUIRED", country: "Cape Verde", note: "Mindelo cruise port" },
  { code: "GOT", source_name: "Gothenburg, Sweden", canonical_name: "Gothenburg", classification: "NEW_PORT_REQUIRED", country: "Sweden" },
  { code: "BBO", source_name: "Bilbao, Spain", canonical_name: "Bilbao", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "LVN", source_name: "Bordeaux (Le Verdon), France", canonical_name: "Le Verdon", classification: "NEW_PORT_REQUIRED", country: "France", note: "Physical cruise port for Bordeaux — not Bordeaux city centre" },
  { code: "ACE", source_name: "Arrecife (Lanzarote), Canary Islands", canonical_name: "Arrecife", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "LCG", source_name: "La Coruña, Spain", canonical_name: "La Coruna", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "GRU", source_name: "Grundarfjordur, Iceland", canonical_name: "Grundarfjordur", classification: "NEW_PORT_REQUIRED", country: "Iceland" },
  { code: "SHI", source_name: "Shimonoseki, Japan", canonical_name: "Shimonoseki", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "SCP", source_name: "Santa Cruz de la Palma, Spain", canonical_name: "Santa Cruz de La Palma", classification: "EXISTING_ALIAS", country: "Spain", note: "La Palma — distinct from Tenerife (SCT)" },
  { code: "GIJ", source_name: "Gijón, Spain", canonical_name: "Gijon", classification: "NEW_PORT_REQUIRED", country: "Spain" },
  { code: "LRH", source_name: "La Rochelle, France", canonical_name: "La Rochelle", classification: "NEW_PORT_REQUIRED", country: "France" },
  { code: "PDR", source_name: "Puerto del Rosario (Canary Islands), Spain", canonical_name: "Puerto del Rosario", classification: "NEW_PORT_REQUIRED", country: "Spain", note: "Fuerteventura" },
  { code: "TKS", source_name: "Takamatsu, Japan", canonical_name: "Takamatsu", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  {
    code: "VGO",
    source_name: "Vigo, Spain",
    canonical_name: "Vigo",
    classification: "EXISTING_ALIAS",
    country: "Spain",
    note: "Galicia cruise port — canonical Vigo already in catalogue"
  },
  {
    code: "MBJ",
    source_name: "Montego Bay, Jamaica",
    canonical_name: "Montego Bay",
    classification: "NEW_PORT_REQUIRED",
    country: "Jamaica"
  },
  {
    code: "LIO",
    source_name: "Puerto Limon, Costa Rica",
    canonical_name: "Puerto Limon",
    classification: "NEW_PORT_REQUIRED",
    country: "Costa Rica",
    note: "Limón cruise port on Caribbean coast"
  },
  {
    code: "PCG",
    source_name: "Panama Canal (Gatun Lake), Panama",
    canonical_name: "Panama Canal Gatun Lake",
    classification: "NEW_PORT_REQUIRED",
    country: "Panama",
    note: "Panama Canal transit / Gatun Lake scenic segment — distinct from Colón pier"
  },
  {
    code: "HGC",
    source_name: "Hubbard Glacier, Alaska",
    canonical_name: "Hubbard Glacier",
    classification: "NEW_PORT_REQUIRED",
    country: "United States",
    note: "Scenic glacier cruising in Disenchantment Bay — not a pier port"
  },
  {
    code: "OLD",
    source_name: "Olden, Norway",
    canonical_name: "Olden",
    classification: "NEW_PORT_REQUIRED",
    country: "Norway",
    note: "Nordfjord cruise port"
  },
  {
    code: "RHO",
    source_name: "Rhodes, Greece",
    canonical_name: "Rhodes",
    classification: "EXISTING_ALIAS",
    country: "Greece"
  },
  {
    code: "ALY",
    source_name: "Alexandria, Egypt",
    canonical_name: "Alexandria",
    classification: "NEW_PORT_REQUIRED",
    country: "Egypt"
  },
  {
    code: "PSD",
    source_name: "Port Said, Egypt",
    canonical_name: "Port Said",
    classification: "NEW_PORT_REQUIRED",
    country: "Egypt"
  },
  {
    code: "SSH",
    source_name: "Sharm el Sheikh, Egypt",
    canonical_name: "Sharm el Sheikh",
    classification: "NEW_PORT_REQUIRED",
    country: "Egypt"
  },
  {
    code: "AQB",
    source_name: "Aqaba, Jordan",
    canonical_name: "Aqaba",
    classification: "NEW_PORT_REQUIRED",
    country: "Jordan"
  },
  { code: "RAI", source_name: "Raiatea, French Polynesia", canonical_name: "Raiatea", classification: "NEW_PORT_REQUIRED", country: "French Polynesia" },
  {
    code: "IVG",
    source_name: "Inverness (Invergordon), Scotland",
    canonical_name: "Invergordon",
    classification: "NEW_PORT_REQUIRED",
    country: "United Kingdom",
    note: "NCL markets Inverness; physical cruise port is Invergordon"
  },
  { code: "APW", source_name: "Apia, Samoa Islands", canonical_name: "Apia", classification: "NEW_PORT_REQUIRED", country: "Samoa" },
  { code: "RAR", source_name: "Rarotonga, Cook Islands", canonical_name: "Rarotonga", classification: "NEW_PORT_REQUIRED", country: "Cook Islands" },
  {
    code: "IPO",
    source_name: "Portland, England",
    canonical_name: "Portland England",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "United Kingdom",
    note: "Dorset cruise port — not Portland Maine"
  },
  { code: "PPG", source_name: "Pago Pago, American Samoa", canonical_name: "Pago Pago", classification: "NEW_PORT_REQUIRED", country: "American Samoa" },
  { code: "PTR", source_name: "Portree, United Kingdom", canonical_name: "Portree", classification: "NEW_PORT_REQUIRED", country: "United Kingdom" },
  {
    code: "TYN",
    source_name: "Newcastle (Tyne), England",
    canonical_name: "Newcastle upon Tyne",
    classification: "NEW_PORT_REQUIRED",
    country: "United Kingdom"
  },
  { code: "TMU", source_name: "Timaru, New Zealand", canonical_name: "Timaru", classification: "NEW_PORT_REQUIRED", country: "New Zealand" },
  { code: "THE", source_name: "Thessaloniki, Greece", canonical_name: "Thessaloniki", classification: "NEW_PORT_REQUIRED", country: "Greece" },
  { code: "BYO", source_name: "Bay of Islands, New Zealand", canonical_name: "Bay of Islands", classification: "NEW_PORT_REQUIRED", country: "New Zealand" },
  { code: "STW", source_name: "Stornoway, United Kingdom", canonical_name: "Stornoway", classification: "NEW_PORT_REQUIRED", country: "United Kingdom" },
  {
    code: "KWL",
    source_name: "Kirkwall, Orkney Isles, Scotland",
    canonical_name: "Kirkwall",
    classification: "NEW_PORT_REQUIRED",
    country: "United Kingdom"
  },
  { code: "KLL", source_name: "Killybegs, Ireland", canonical_name: "Killybegs", classification: "NEW_PORT_REQUIRED", country: "Ireland" },
  { code: "BOR", source_name: "Boracay, Philippines", canonical_name: "Boracay", classification: "NEW_PORT_REQUIRED", country: "Philippines" },
  {
    code: "NTL",
    source_name: "Newcastle, Australia",
    canonical_name: "Newcastle Australia",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Australia",
    note: "New South Wales cruise port — not Newcastle upon Tyne"
  },
  {
    code: "DPS",
    source_name: "Bali (Benoa), Indonesia",
    canonical_name: "Benoa",
    classification: "NEW_PORT_REQUIRED",
    country: "Indonesia",
    note: "NCL markets Bali; physical cruise port is Benoa"
  },
  { code: "ABZ", source_name: "Aberdeen, Scotland", canonical_name: "Aberdeen", classification: "NEW_PORT_REQUIRED", country: "United Kingdom" },
  { code: "ALT", source_name: "Alta, Norway", canonical_name: "Alta", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "KRD", source_name: "Kristiansund, Norway", canonical_name: "Kristiansund", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "HAU", source_name: "Haugesund, Norway", canonical_name: "Haugesund", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "CRH", source_name: "Cam Ranh, Vietnam", canonical_name: "Cam Ranh", classification: "NEW_PORT_REQUIRED", country: "Vietnam" },
  { code: "SKT", source_name: "Sakata, Japan", canonical_name: "Sakata", classification: "NEW_PORT_REQUIRED", country: "Japan" },
  { code: "ADQ", source_name: "Kodiak, Alaska", canonical_name: "Kodiak", classification: "NEW_PORT_REQUIRED", country: "United States" },
  { code: "HSY", source_name: "Hellesylt, Norway", canonical_name: "Hellesylt", classification: "NEW_PORT_REQUIRED", country: "Norway" },
  { code: "THO", source_name: "Torshavn, Faroe Islands", canonical_name: "Torshavn", classification: "NEW_PORT_REQUIRED", country: "Faroe Islands" },
  { code: "AIT", source_name: "Aitutaki, Cook Islands", canonical_name: "Aitutaki", classification: "NEW_PORT_REQUIRED", country: "Cook Islands" },
  { code: "SUB", source_name: "Surabaya, Indonesia", canonical_name: "Surabaya", classification: "NEW_PORT_REQUIRED", country: "Indonesia" },
  { code: "BUS", source_name: "Busselton, Australia", canonical_name: "Busselton", classification: "NEW_PORT_REQUIRED", country: "Australia" },
  { code: "ESP", source_name: "Esperance, Australia", canonical_name: "Esperance", classification: "NEW_PORT_REQUIRED", country: "Australia" },
  {
    code: "ALB",
    source_name: "Albany, Australia",
    canonical_name: "Albany Australia",
    classification: "DISTINCT_PORT_REQUIRED",
    country: "Australia",
    note: "Western Australia cruise port — not Albany New York"
  },
  {
    code: "LEM",
    source_name: "Lembar (Lombok), Indonesia",
    canonical_name: "Lembar",
    classification: "NEW_PORT_REQUIRED",
    country: "Indonesia",
    note: "Lombok cruise port"
  },
  {
    code: "LRM",
    source_name: "Punta Cana (La Romana), Dominican Republic",
    canonical_name: "La Romana",
    classification: "NEW_PORT_REQUIRED",
    country: "Dominican Republic",
    note: "NCL markets Punta Cana; physical cruise port is La Romana"
  }
]);

const POC_CODE_TO_MAPPING = Object.freeze(Object.fromEntries(NCL_PORT_OF_CALL_CODES.map((row) => [row.code, row])));

function getPortOfCallMapping(code) {
  const normalised = String(code || "").trim().toUpperCase();
  return POC_CODE_TO_MAPPING[normalised] || null;
}

function getPortOfCallCanonicalName(code) {
  return getPortOfCallMapping(code)?.canonical_name || null;
}

function listPortOfCallCodes() {
  return NCL_PORT_OF_CALL_CODES.slice();
}

module.exports = {
  NCL_PORT_OF_CALL_CODES,
  POC_CODE_TO_MAPPING,
  getPortOfCallMapping,
  getPortOfCallCanonicalName,
  listPortOfCallCodes
};
