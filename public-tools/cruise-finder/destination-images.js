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

  const W = "https://upload.wikimedia.org/wikipedia/commons/thumb";

  function thumb(path, file, width) {
    const w = width || 1280;
    return `${W}/${path}/${file}/${w}px-${file}`;
  }

  /**
   * Verified images for all supported destinations.
   * seasonal: month number (1–12) → image override
   */
  const DESTINATION_IMAGES = {
    alaska: {
      default: {
        url: thumb(
          "5/53",
          "Glaciar_Mendenhall%2C_Juneau%2C_Alaska%2C_Estados_Unidos%2C_2017-08-17%2C_DD_01.jpg"
        ),
        objectPosition: "center center",
        credit: "Diego Delso / Wikimedia Commons"
      },
      seasonal: {}
    },
    japan: {
      default: {
        url: thumb("3/33", "Mount_Fuji_from_Lake_Kawaguchi_%282015-10-26%29.jpg"),
        objectPosition: "center 40%",
        credit: "Wikimedia Commons"
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
        url: thumb("e/ec", "Positano_-_7268.jpg"),
        objectPosition: "center 35%",
        credit: "Wikimedia Commons"
      },
      seasonal: {}
    },
    "greek-islands": {
      default: {
        url: thumb("6/62", "Oia_Santorini_06_2017_3496.jpg"),
        objectPosition: "center 40%",
        credit: "Wikimedia Commons"
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
        url: thumb("d/d5", "Giant%27s_Causeway_%2814%29.JPG"),
        objectPosition: "center 55%",
        credit: "Wikimedia Commons"
      },
      seasonal: {}
    },
    caribbean: {
      default: {
        url: thumb("8/82", "Eagle_Beach%2C_Aruba_1.jpg"),
        objectPosition: "center 45%",
        credit: "Wikimedia Commons"
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
        url: thumb("d/dd", "Milford_Sound_in_Fiordland_National_Park_08.jpg"),
        objectPosition: "center 40%",
        credit: "Wikimedia Commons"
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
        url: "images/hawaii-hero.png",
        objectPosition: "center 42%",
        credit: "101cruise"
      },
      seasonal: {}
    }
  };

  function pickImage(destinationId, travelMonth) {
    const entry = DESTINATION_IMAGES[destinationId];
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
