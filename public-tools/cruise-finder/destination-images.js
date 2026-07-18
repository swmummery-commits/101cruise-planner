/**
 * Cruise Finder — verified destination hero images.
 *
 * Royalty-free Wikimedia Commons landscapes (commercial-suitable licences).
 * No live/random search at runtime — only these approved URLs.
 *
 * Each entry: url + objectPosition for 16:9-ish hero cropping.
 */
(function (root) {
  "use strict";

  const ASSET_BASE = "https://admirable-tiramisu-d4da8a.netlify.app/public-tools/cruise-finder/";
  const W = "https://upload.wikimedia.org/wikipedia/commons/thumb";

  function localHero(file) {
    return `${ASSET_BASE}images/${file}`;
  }

  function thumb(path, file, width) {
    const w = width || 1280;
    return `${W}/${path}/${file}/${w}px-${file}`;
  }

  /** Alias → canonical destination slug */
  const DESTINATION_ALIASES = {
    japan: "japan",
    "australia-new-zealand": "australia-new-zealand",
    "australia-nz": "australia-new-zealand",
    anz: "australia-new-zealand",
    mediterranean: "mediterranean",
    med: "mediterranean",
    caribbean: "caribbean",
    alaska: "alaska",
    "greek-islands": "greek-islands",
    greece: "greek-islands",
    "norwegian-fjords": "norwegian-fjords",
    norway: "norwegian-fjords",
    fjords: "norwegian-fjords",
    "british-isles": "british-isles",
    uk: "british-isles",
    "south-pacific": "south-pacific",
    antarctica: "antarctica",
    "canada-new-england": "canada-new-england",
    hawaii: "hawaii"
  };

  /**
   * Verified images for all supported destinations.
   * seasonal: month number (1–12) → image override
   * Local approved PNGs use absolute Netlify URLs so Squarespace embeds never
   * resolve against www.101cruise.com.au.
   */
  const DESTINATION_IMAGES = {
    alaska: {
      default: {
        url: localHero("alaska-hero.png"),
        objectPosition: "center 40%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    japan: {
      default: {
        url: localHero("japan-hero.png"),
        objectPosition: "center center",
        credit: "101cruise"
      },
      seasonal: {
        3: {
          url: thumb("9/94", "Miyagi-Landscape_of_cherry_blossoms_and_Matsushima_Bay-xl.jpg"),
          objectPosition: "center 40%",
          credit: "Wikimedia Commons"
        },
        4: {
          url: thumb("9/94", "Miyagi-Landscape_of_cherry_blossoms_and_Matsushima_Bay-xl.jpg"),
          objectPosition: "center 40%",
          credit: "Wikimedia Commons"
        },
        10: {
          url: thumb("4/4a", "Eikan-do_Zenrin-ji%2C_November_2016_-03.jpg"),
          objectPosition: "center 35%",
          credit: "Wikimedia Commons"
        },
        11: {
          url: thumb("4/4a", "Eikan-do_Zenrin-ji%2C_November_2016_-03.jpg"),
          objectPosition: "center 35%",
          credit: "Wikimedia Commons"
        }
      }
    },
    mediterranean: {
      default: {
        url: localHero("mediterranean-hero.png"),
        objectPosition: "center 40%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    "greek-islands": {
      default: {
        url: localHero("greek-islands-hero.png"),
        objectPosition: "center 40%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    "norwegian-fjords": {
      default: {
        url: thumb(
          "7/77",
          "Fiordo_de_Geiranger_desde_Flydalsjuvet%2C_Noruega%2C_2019-09-07%2C_DD_59.jpg"
        ),
        objectPosition: "center center",
        credit: "Diego Delso / Wikimedia Commons"
      },
      seasonal: {}
    },
    "british-isles": {
      default: {
        url: localHero("british-isles-hero.png"),
        objectPosition: "center 40%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    caribbean: {
      default: {
        url: localHero("caribbean-hero.png"),
        objectPosition: "center 45%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    "south-pacific": {
      default: {
        url: thumb("f/f8", "Boraboraluft.jpg"),
        objectPosition: "center center",
        credit: "Wikimedia Commons"
      },
      seasonal: {}
    },
    "australia-new-zealand": {
      default: {
        url: localHero("australia-new-zealand-hero.png"),
        objectPosition: "center 45%",
        credit: "101cruise"
      },
      seasonal: {}
    },
    antarctica: {
      default: {
        url: thumb(
          "0/03",
          "Chinstrap_penguins_on_a_striated_iceberg%2C_South_Shetland_Islands%2C_Antarctica.jpg"
        ),
        objectPosition: "center center",
        credit: "Wikimedia Commons"
      },
      seasonal: {}
    },
    "canada-new-england": {
      default: {
        url: thumb(
          "4/45",
          "Lighthouse_DSC01066_-_Peggy%27s_Cove_Lighthouse_%287612052968%29.jpg"
        ),
        objectPosition: "center 45%",
        credit: "Wikimedia Commons"
      },
      seasonal: {
        9: {
          url: thumb("7/75", "Lake_Willoughby_October_2021_003.jpg"),
          objectPosition: "center 40%",
          credit: "Wikimedia Commons"
        },
        10: {
          url: thumb("7/75", "Lake_Willoughby_October_2021_003.jpg"),
          objectPosition: "center 40%",
          credit: "Wikimedia Commons"
        }
      }
    },
    hawaii: {
      default: {
        url: localHero("hawaii-hero.png"),
        objectPosition: "center 42%",
        credit: "101cruise"
      },
      seasonal: {}
    }
  };

  function canonicalDestinationId(destinationId) {
    const raw = String(destinationId || "")
      .trim()
      .toLowerCase();
    return DESTINATION_ALIASES[raw] || raw;
  }

  function pickImage(destinationId, travelMonth) {
    const id = canonicalDestinationId(destinationId);
    const entry = DESTINATION_IMAGES[id];
    if (!entry) return null;
    const month = Number(travelMonth) || 0;
    if (month && entry.seasonal && entry.seasonal[month]) {
      return entry.seasonal[month];
    }
    return entry.default || null;
  }

  root.CruiseFinderDestinationImages = DESTINATION_IMAGES;
  root.CruiseFinderPickDestinationImage = pickImage;
})(typeof window !== "undefined" ? window : globalThis);
