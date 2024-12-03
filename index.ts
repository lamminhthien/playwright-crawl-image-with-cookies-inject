import { firefox, Page } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
const cookiesConfig = JSON.parse(fs.readFileSync("./cookies.json", "utf-8"));

interface ImageData {
  src: string;
  alt: string;
  title?: string;
}

const SEARCH_TERMS = [
  "carrot",
  "melon",
  "tomato",
  "perper",
  "kubis",
  "banana",
  "oil_palm",
  "coffee",
  "cereals",
  "cabbage",
  "cabai",
  "kelap_sawit",
  "cucumber",
  "cotton",
  "potato",
  "cauliflower",
  "rice",
  "jeruk",
  "soybean",
  "spinach",
  "citrus",
  "sugarcane",
  "strawberry",
  "grapes_and_vines",
  "apple",
];

const CONFIG = {
  url: "example",
  maxLoadAttempts: 10,
  waitTimeout: 2000,
  cookies: cookiesConfig.cookies,
};

class PageHandler {
  private page: Page;
  private searchTerm: string;
  private networkRequests: string[] = [];

  constructor(page: Page, searchTerm: string) {
    this.page = page;
    this.searchTerm = searchTerm;
    this.setupNetworkCapture();
  }

  private setupNetworkCapture() {
    this.page.on("response", async (response) => {
      const url = response.url();
      if (url.startsWith("https://test.example.com/fr/gallery")) {
        this.networkRequests.push(url);
        try {
          const buffer = await response.body();
          const saveDir = `./${this.searchTerm}_images`;

          if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir);
          }

          const imageCount = fs.readdirSync(saveDir).length + 1;
          const fileName = `${this.searchTerm}-${imageCount}.png`;

          fs.writeFileSync(path.join(saveDir, fileName), buffer);
          console.log(`Captured: ${fileName}`);
        } catch (err) {
          console.error(`Failed to save: ${url}`, err);
        }
      }
    });
  }

  async waitForNewContent(): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {
      console.log("Network idle timeout");
    });

    await this.page.waitForFunction(() => {
      return new Promise((resolve) => {
        const observer = new MutationObserver((mutations, obs) => {
          obs.disconnect();
          resolve(true);
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
        });

        setTimeout(() => {
          observer.disconnect();
          resolve(true);
        }, 1000);
      });
    });
  }

  async performSearch(): Promise<void> {
    const searchInput = await this.page.waitForSelector(
      'input[type="search"].c-tag-input__input[placeholder="Start searching…"]'
    );

    await searchInput?.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(500);
    await searchInput?.click();
    await searchInput?.fill("");
    await searchInput?.fill(this.searchTerm);
    await this.page.keyboard.press("Enter");
    await this.page.waitForTimeout(1000);
    await this.page.click(".c-tag-input__slot pf-icon");
    await this.page.waitForTimeout(2000);
  }

  async loadAllImages(): Promise<void> {
    let previousHeight = 0;
    let attempts = 0;

    while (attempts < CONFIG.maxLoadAttempts) {
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await this.page.waitForTimeout(CONFIG.waitTimeout);

      try {
        const loadMoreButton = await this.page.$("div[load-more-btn] button.place-view-btn");
        if (!loadMoreButton) {
          console.log("No more content to load");
          break;
        }

        await loadMoreButton.click();
        await this.page.waitForTimeout(CONFIG.waitTimeout);

        const currentHeight = await this.page.evaluate(() => document.body.scrollHeight);
        if (currentHeight === previousHeight) {
          attempts++;
          console.log(`No new content. Attempt ${attempts}/${CONFIG.maxLoadAttempts}`);
        } else {
          attempts = 0;
          previousHeight = currentHeight;
        }

        await this.waitForNewContent();
      } catch (error) {
        attempts++;
      }
    }

    fs.writeFileSync(
      `captured_urls_${this.searchTerm}.json`,
      JSON.stringify([...new Set(this.networkRequests)], null, 2)
    );
  }
}

class ImageScraper {
  static async initialize() {
    const browser = await firefox.launch({
      headless: false,
    });
    const context = await browser.newContext();
    await context.addCookies(CONFIG.cookies);
    return { browser, context };
  }

  static async run(): Promise<void> {
    const { browser, context } = await this.initialize();
    const page = await context.newPage();

    try {
      for (const searchTerm of SEARCH_TERMS) {
        console.log(`Processing: ${searchTerm}`);
        const pageHandler = new PageHandler(page, searchTerm);

        // Reload page before each search
        await page.goto(CONFIG.url, { waitUntil: "networkidle" });
        await page.waitForLoadState("domcontentloaded");

        await pageHandler.performSearch();
        await pageHandler.loadAllImages();
        await page.waitForTimeout(2000);
      }

      await new Promise(() => {});
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  }
}

ImageScraper.run();
