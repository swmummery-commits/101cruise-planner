/**
 * Cruise Finder — destination detail content (lightweight seed).
 * Complements destinations.js without affecting recommendation scoring.
 */
(function (root) {
  "use strict";

  const CONTENT = {
    alaska: {
      popular_ports: ["Juneau", "Skagway", "Ketchikan", "Sitka", "Icy Strait Point", "Seward"],
      departure_ports: ["Vancouver", "Seattle", "Seward", "Whittier"],
      key_reasons: [
        "Glacier viewing on a grand scale",
        "Wildlife often visible from deck",
        "Dramatic scenic cruising through Inside Passage waters",
        "Cool-climate summer itineraries",
        "A classic bucket-list cruise experience"
      ],
      suited_to: "Scenic travellers, wildlife lovers and cooler-climate holidays",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to August is the main Alaska cruise season, with long daylight and active wildlife.",
        shoulder: "April and September can still work, though sailings and weather are more variable.",
        quieter: "Outside May–September there are typically very few Alaska cruise options.",
        weather: "Expect cool, changeable conditions — pack layers even in midsummer."
      }
    },
    japan: {
      popular_ports: ["Tokyo / Yokohama", "Kobe", "Osaka", "Nagasaki", "Hakodate", "Aomori"],
      departure_ports: ["Tokyo / Yokohama", "Kobe", "Osaka"],
      key_reasons: [
        "Strong cultural experiences in every port",
        "Excellent food at sea and ashore",
        "Convenient access to major cities",
        "Scenic coastal sailing between islands",
        "Distinct spring and autumn seasonal appeal"
      ],
      suited_to: "Culture, food and first-time Japan travellers",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "March–May and September–November typically offer the most comfortable cruising weather.",
        shoulder: "February, June and December can still work for travellers with flexible expectations.",
        quieter: "Peak summer humidity can mean fewer ideal sailing windows for some travellers.",
        weather: "Spring and autumn are milder; summers are humid and winters cooler in the north."
      }
    },
    mediterranean: {
      popular_ports: ["Barcelona", "Rome (Civitavecchia)", "Santorini", "Athens (Piraeus)", "Dubrovnik", "Venice / Ravenna"],
      departure_ports: ["Barcelona", "Rome (Civitavecchia)", "Athens (Piraeus)", "Istanbul"],
      key_reasons: [
        "Layered history in classic European ports",
        "Sunlit coastal scenery",
        "Excellent food and wine culture",
        "Wide choice of itinerary lengths",
        "Easy island and city combinations"
      ],
      suited_to: "Culture lovers, couples and warm-weather travellers",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to September is the classic Mediterranean cruise season.",
        shoulder: "April and October often bring milder crowds and still-pleasant weather.",
        quieter: "Winter sailings exist but are fewer and more weather-dependent.",
        weather: "Summers are hot and dry; spring and autumn are typically more comfortable ashore."
      }
    },
    "greek-islands": {
      popular_ports: ["Santorini", "Mykonos", "Rhodes", "Crete", "Athens (Piraeus)", "Corfu"],
      departure_ports: ["Athens (Piraeus)", "Istanbul", "Rome (Civitavecchia)"],
      key_reasons: [
        "Whitewashed villages and Aegean colour",
        "Excellent island-hopping itineraries",
        "Strong swimming and beach days",
        "Relaxed Mediterranean dining culture",
        "Iconic sunset harbours"
      ],
      suited_to: "Warm-weather travellers, couples and island lovers",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to September offers the most reliable Greek Islands weather.",
        shoulder: "April and October can still be lovely with fewer crowds.",
        quieter: "Winter sailings are limited compared with the summer peak.",
        weather: "Expect hot, dry summers and excellent swimming conditions mid-season."
      }
    },
    "norwegian-fjords": {
      popular_ports: ["Bergen", "Geiranger", "Flam", "Stavanger", "Tromsø", "Ålesund"],
      departure_ports: ["Bergen", "Copenhagen", "Southampton", "Amsterdam"],
      key_reasons: [
        "Spectacular fjord scenery",
        "Quiet waters and dramatic cliffs",
        "Cool-climate scenic cruising",
        "Charming coastal towns",
        "Long summer daylight"
      ],
      suited_to: "Scenic travellers and cooler-climate holidays",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to August is the strongest fjord season.",
        shoulder: "April and September can still deliver fine scenery with changeable weather.",
        quieter: "Winter fjord sailings are limited and more expedition-style.",
        weather: "Cool summers with bright evenings; pack for rain and wind."
      }
    },
    "british-isles": {
      popular_ports: ["Edinburgh / Newhaven", "Dublin", "Cork", "Liverpool", "Invergordon", "Belfast"],
      departure_ports: ["Southampton", "Dover", "Amsterdam", "Copenhagen"],
      key_reasons: [
        "Historic harbours and coastal drama",
        "Strong cultural shore days",
        "Green countryside close to port",
        "Varied island and mainland stops",
        "Comfortable summer cruising"
      ],
      suited_to: "Culture travellers and scenic coastal holidays",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to September is typically the most popular British Isles season.",
        shoulder: "April and October can still work with more changeable weather.",
        quieter: "Winter options are fewer outside specialised itineraries.",
        weather: "Mild summers with frequent cloud and showers — pack layers."
      }
    },
    caribbean: {
      popular_ports: ["St Thomas", "Cozumel", "St Maarten", "Barbados", "Nassau", "Grand Cayman"],
      departure_ports: ["Miami", "Fort Lauderdale", "San Juan", "Galveston"],
      key_reasons: [
        "Turquoise water and beach days",
        "Easy island-hopping itineraries",
        "Warm-weather relaxation",
        "Wide choice of ship styles",
        "Strong winter-escape appeal"
      ],
      suited_to: "Beach lovers, families and warm-weather travellers",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "December to April is typically the preferred Caribbean window.",
        shoulder: "May and November can still work, with more humidity and shower risk.",
        quieter: "Peak hurricane season months deserve careful itinerary advice.",
        weather: "Warm to hot year-round; drier months usually feel most reliable."
      }
    },
    "south-pacific": {
      popular_ports: ["Noumea", "Suva", "Port Vila", "Lautoka", "Mystery Island", "Lifou"],
      departure_ports: ["Sydney", "Brisbane", "Auckland"],
      key_reasons: [
        "Lagoon blues within closer reach of home",
        "Relaxed island days",
        "Convenient departures from Australia & New Zealand",
        "Warm-weather swimming",
        "A genuine tropical escape without the longest flight"
      ],
      suited_to: "Families, couples and warm-weather travellers from Australia & NZ",
      proximity: "Closer to home for Australia & New Zealand",
      seasonal_advice: {
        best: "May to October typically offers more settled dry-season conditions.",
        shoulder: "April and November can still be attractive with careful weather advice.",
        quieter: "Wet-season months may see more tropical showers and itinerary changes.",
        weather: "Warm tropical conditions; dry season is usually more predictable."
      }
    },
    "australia-new-zealand": {
      popular_ports: ["Sydney", "Melbourne", "Hobart", "Auckland", "Wellington", "Dunedin / Port Chalmers"],
      departure_ports: ["Sydney", "Brisbane", "Melbourne", "Auckland"],
      key_reasons: [
        "Home-port convenience",
        "Coastal cities and island stops",
        "World-class New Zealand scenery",
        "Flexible cruise lengths",
        "No long-haul flight before boarding"
      ],
      suited_to: "First-time cruisers, families and travellers wanting simpler logistics",
      proximity: "Closer to home for Australia & New Zealand",
      seasonal_advice: {
        best: "November to March is typically the strongest season for AU & NZ cruising.",
        shoulder: "April and October can still offer good value and milder conditions.",
        quieter: "Mid-winter sailings are fewer on some routes.",
        weather: "Warm summers; spring and autumn are milder along the coast."
      }
    },
    antarctica: {
      popular_ports: ["Ushuaia", "Port Stanley", "South Shetland landings", "Antarctic Peninsula sites"],
      departure_ports: ["Ushuaia", "Buenos Aires", "Punta Arenas"],
      key_reasons: [
        "True expedition wilderness",
        "Ice, silence and wildlife",
        "A once-in-a-lifetime travel experience",
        "Smaller-ship exploration",
        "Seasonal access only"
      ],
      suited_to: "Adventure travellers and bucket-list expedition guests",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "November to March is the Antarctic cruise season.",
        shoulder: "Early and late season sailings can be excellent but more weather-exposed.",
        quieter: "There is effectively no Antarctica cruise season outside the southern summer.",
        weather: "Cold expedition conditions — specialist packing and flexibility are essential."
      }
    },
    "canada-new-england": {
      popular_ports: ["Quebec City", "Halifax", "Boston", "Bar Harbor", "Saint John", "Sydney (Nova Scotia)"],
      departure_ports: ["New York", "Montreal", "Boston", "Quebec City"],
      key_reasons: [
        "Harbour towns and coastal scenery",
        "Strong autumn colour in season",
        "Historic shore days",
        "Comfortable scenic cruising",
        "A classic North Atlantic itinerary"
      ],
      suited_to: "Scenic and culture travellers, especially in autumn",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "May to October covers the main season; September–October favour autumn colour.",
        shoulder: "April can work for early sailings with cooler conditions.",
        quieter: "Winter options are limited outside specialised itineraries.",
        weather: "Mild summers; autumn is crisp and colourful along the Atlantic coast."
      }
    },
    hawaii: {
      popular_ports: ["Honolulu", "Maui (Kahului)", "Kona", "Hilo", "Nawiliwili (Kauai)"],
      departure_ports: ["Honolulu", "Vancouver", "Los Angeles", "San Francisco"],
      key_reasons: [
        "Volcanic island scenery",
        "Easy inter-island cruising",
        "Beaches and ocean swimming",
        "Warm weather year-round",
        "A relaxed tropical escape"
      ],
      suited_to: "Beach lovers, couples and warm-weather travellers",
      proximity: "Long-haul from Australia & New Zealand",
      seasonal_advice: {
        best: "Most months work well; many travellers prefer cooler, drier windows outside midsummer.",
        shoulder: "June to August remain popular despite warmer, busier conditions.",
        quieter: "Hawaii remains cruised year-round compared with highly seasonal destinations.",
        weather: "Warm year-round with trade winds and occasional tropical showers."
      }
    }
  };

  function getDestinationContent(id) {
    return CONTENT[id] || null;
  }

  root.CruiseFinderDestinationContent = CONTENT;
  root.CruiseFinderGetDestinationContent = getDestinationContent;
})(typeof window !== "undefined" ? window : globalThis);
