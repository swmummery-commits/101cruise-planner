/**
 * Featured ports for Cruise Finder destinations on Living Destination pages.
 * Source: former Cruise Finder destination-content.js popular_ports + editorial one-liners.
 */
export const CRUISE_FINDER_FEATURED_PORTS = {
  alaska: [
    { name: "Juneau", slug: "juneau", short_description: "Alaska's capital — glaciers nearby, whale watching and a walkable waterfront.", display_order: 10 },
    { name: "Skagway", slug: "skagway", short_description: "Gold-rush town with the White Pass railway and a charming main street.", display_order: 20 },
    { name: "Ketchikan", slug: "ketchikan", short_description: "Totem poles, creek walks and rainforest scenery at the start of many itineraries.", display_order: 30 },
    { name: "Sitka", slug: "sitka", short_description: "Russian and Tlingit heritage with quieter harbour energy and coastal trails.", display_order: 40 },
    { name: "Icy Strait Point", slug: "icy-strait-point", short_description: "Wildlife, zip lines and a soft adventure stop near Hoonah.", display_order: 50 }
  ],
  japan: [
    { name: "Tokyo / Yokohama", slug: "tokyo-yokohama", short_description: "Neon cities and temples within easy reach — a natural start or finish for Japan cruises.", display_order: 10 },
    { name: "Kobe", slug: "kobe", short_description: "Harbour city famous for beef, sake and views toward the Rokko mountains.", display_order: 20 },
    { name: "Osaka", slug: "osaka", short_description: "Bold food culture, castle gardens and easy day trips into central Kansai.", display_order: 30 },
    { name: "Nagasaki", slug: "nagasaki", short_description: "Hillside harbour with Dutch heritage, peace memorials and lantern-lit evenings.", display_order: 40 },
    { name: "Hakodate", slug: "hakodate", short_description: "Northern port known for its night views, morning market and Hokkaido scenery.", display_order: 50 }
  ],
  mediterranean: [
    { name: "Barcelona", slug: "barcelona", short_description: "Gaudí architecture, Las Ramblas and a lively embarkation port on the Catalan coast.", display_order: 10 },
    { name: "Rome (Civitavecchia)", slug: "civitavecchia", short_description: "Gateway to Rome's ancient sites, piazzas and world-class dining ashore.", display_order: 20 },
    { name: "Santorini", slug: "santorini", short_description: "Caldera views, whitewashed villages and cliff-side sunsets above the Aegean.", display_order: 30 },
    { name: "Athens (Piraeus)", slug: "piraeus", short_description: "Acropolis access and Greek island connections from the country's main cruise hub.", display_order: 40 },
    { name: "Dubrovnik", slug: "dubrovnik", short_description: "Walled Old Town, Adriatic colour and easy walks along the limestone coast.", display_order: 50 }
  ],
  "greek-islands": [
    { name: "Santorini", slug: "santorini", short_description: "Iconic caldera views and cliff-side villages — the postcard Greek Islands stop.", display_order: 10 },
    { name: "Mykonos", slug: "mykonos", short_description: "Windmills, beach clubs and a relaxed Cycladic harbour atmosphere.", display_order: 20 },
    { name: "Rhodes", slug: "rhodes", short_description: "Medieval Old Town walls and sunny Dodecanese beaches within walking distance.", display_order: 30 },
    { name: "Crete", slug: "crete", short_description: "Minoan history, mountain villages and long Mediterranean swimming days.", display_order: 40 },
    { name: "Corfu", slug: "corfu", short_description: "Green Ionian island with Venetian architecture and a gentle resort pace.", display_order: 50 }
  ],
  "norwegian-fjords": [
    { name: "Bergen", slug: "bergen", short_description: "Colourful Bryggen wharf and the gateway to Norway's most famous fjord country.", display_order: 10 },
    { name: "Geiranger", slug: "geiranger", short_description: "Sheer cliffs and waterfall scenery in one of the world's most photographed fjords.", display_order: 20 },
    { name: "Flam", slug: "flam", short_description: "Railway village at the head of Aurlandsfjord — scenic trains and hiking trails.", display_order: 30 },
    { name: "Stavanger", slug: "stavanger", short_description: "Old town cobbles and access to Pulpit Rock hikes along the southwest coast.", display_order: 40 },
    { name: "Tromsø", slug: "tromso", short_description: "Arctic cathedral city with midnight sun sailings and northern-light potential.", display_order: 50 }
  ],
  "british-isles": [
    { name: "Edinburgh / Newhaven", slug: "edinburgh-newhaven", short_description: "Castle skyline, Royal Mile walks and easy access to Scotland's highland edge.", display_order: 10 },
    { name: "Dublin", slug: "dublin", short_description: "Literary pubs, Georgian squares and a compact city centre from the port.", display_order: 20 },
    { name: "Cork", slug: "cork", short_description: "Southern Ireland gateway to Blarney, Kinsale and the Wild Atlantic mood.", display_order: 30 },
    { name: "Liverpool", slug: "liverpool", short_description: "Waterfront revival, Beatles heritage and a confident northern English city.", display_order: 40 },
    { name: "Belfast", slug: "belfast", short_description: "Titanic Quarter museums and Causeway Coast excursions from a re-energised harbour.", display_order: 50 }
  ],
  caribbean: [
    { name: "St Thomas", slug: "st-thomas", short_description: "Duty-free shopping, beach clubs and classic eastern Caribbean island days.", display_order: 10 },
    { name: "Cozumel", slug: "cozumel", short_description: "Mexican Caribbean reefs, beach resorts and easy snorkelling from the pier.", display_order: 20 },
    { name: "St Maarten", slug: "st-maarten", short_description: "Dual-nation island with lively beaches and great food on both French and Dutch sides.", display_order: 30 },
    { name: "Barbados", slug: "barbados", short_description: "Calm west-coast beaches, rum culture and a polished independent Caribbean welcome.", display_order: 40 },
    { name: "Grand Cayman", slug: "grand-cayman", short_description: "Clear-water snorkelling, stingray sandbars and a relaxed British Caribbean feel.", display_order: 50 }
  ],
  "south-pacific": [
    { name: "Noumea", slug: "noumea", short_description: "French Pacific flair, lagoon swimming and a relaxed New Caledonia capital.", display_order: 10 },
    { name: "Suva", slug: "suva", short_description: "Fiji's harbour capital with markets, colonial architecture and island warmth.", display_order: 20 },
    { name: "Port Vila", slug: "port-vila", short_description: "Vanuatu's friendly waterfront and easy access to blue holes and island culture.", display_order: 30 },
    { name: "Lautoka", slug: "lautoka", short_description: "Fiji's sugar-city port — gateway to coral coast beaches and village visits.", display_order: 40 },
    { name: "Mystery Island", slug: "mystery-island", short_description: "Tiny uninhabited stop with turquoise shallows and a true castaway beach day.", display_order: 50 }
  ],
  "australia-new-zealand": [
    { name: "Sydney", slug: "sydney", short_description: "Harbour sailing past the Opera House — Australia's flagship home-port experience.", display_order: 10 },
    { name: "Melbourne", slug: "melbourne", short_description: "Laneway dining, bay-side suburbs and a cultured southern capital ashore.", display_order: 20 },
    { name: "Hobart", slug: "hobart", short_description: "Salamanca markets, Mount Wellington views and Tasmanian wilderness nearby.", display_order: 30 },
    { name: "Auckland", slug: "auckland", short_description: "City of sails with volcanic cones, wine regions and North Island departures.", display_order: 40 },
    { name: "Wellington", slug: "wellington", short_description: "Compact capital with harbour walks, craft coffee and access to Marlborough.", display_order: 50 }
  ],
  antarctica: [
    { name: "Ushuaia", slug: "ushuaia", short_description: "World's southernmost city — the classic embarkation point for Antarctic expeditions.", display_order: 10 },
    { name: "Port Stanley", slug: "port-stanley", short_description: "Falkland Islands capital with wildlife, British charm and expedition storytelling.", display_order: 20 },
    { name: "Antarctic Peninsula", slug: "antarctic-peninsula", short_description: "Zodiac landings among penguins, icebergs and truly remote polar scenery.", display_order: 30 },
    { name: "South Shetland Islands", slug: "south-shetland-islands", short_description: "First Antarctic landings for many expeditions — busy penguin colonies and dramatic ice.", display_order: 40 },
    { name: "Drake Passage", slug: "drake-passage", short_description: "The legendary crossing — seabirds, open ocean and the rite of passage to the white continent.", display_order: 50 }
  ],
  "canada-new-england": [
    { name: "Quebec City", slug: "quebec-city", short_description: "Old World ramparts, French-Canadian cuisine and autumn colour at its finest.", display_order: 10 },
    { name: "Halifax", slug: "halifax", short_description: "Maritime history, lobster rolls and a walkable Nova Scotia waterfront.", display_order: 20 },
    { name: "Boston", slug: "boston", short_description: "Freedom Trail history, harbour islands and classic New England city energy.", display_order: 30 },
    { name: "Bar Harbor", slug: "bar-harbor", short_description: "Acadia National Park gateway — rocky coast, lobster and crisp autumn air.", display_order: 40 },
    { name: "Saint John", slug: "saint-john", short_description: "Bay of Fundy tides, red-brick streets and a friendly New Brunswick port.", display_order: 50 }
  ],
  hawaii: [
    { name: "Honolulu", slug: "honolulu", short_description: "Waikiki beaches, Pearl Harbor history and the natural hub of an inter-island cruise.", display_order: 10 },
    { name: "Maui (Kahului)", slug: "maui-kahului", short_description: "Road to Hana scenery, volcano sunrises and some of Hawaii's best beaches.", display_order: 20 },
    { name: "Kona", slug: "kona", short_description: "Volcanic black-sand coast, coffee country and calm leeward swimming.", display_order: 30 },
    { name: "Hilo", slug: "hilo", short_description: "Lush rainforests, waterfalls and the Big Island's wilder eastern shore.", display_order: 40 },
    { name: "Nawiliwili (Kauai)", slug: "nawiliwili-kauai", short_description: "Garden Isle cliffs, Na Pali views and a slower, greener Hawaiian pace.", display_order: 50 }
  ]
};

export const CRUISE_FINDER_DESTINATION_SLUGS = Object.keys(CRUISE_FINDER_FEATURED_PORTS);
