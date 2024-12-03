import { firefox, Page } from "playwright";
import fs from "fs";
import path from "path";
import https from "https";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const cookiesConfig = JSON.parse(fs.readFileSync("./cookies.json", "utf-8"));

interface ImageData {
  src: string;
  alt: string;
  title?: string;
}

const SEARCH_TERMS = [
  "carrot",
  "apple",
];

const CONFIG = {
  url: process.env.BASE_URL,
  maxLoadAttempts: 10,
  waitTimeout: 2000,
  cookies: cookiesConfig.cookies,
};

// Initialize required directories
function initializeDirectories(): void {
  const directories = ['output', 'images'];
  
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
      console.log(`Created ${dir} directory`);
    }
  });
  
  // Create image subdirectories for each search term
  SEARCH_TERMS.forEach(term => {
    const imageDir = `./images/images_${term}`;
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
      console.log(`Created directory: ${imageDir}`);
    }
  });
}

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
      if (url.startsWith(process.env.GALLERY_URL_PREFIX)) {
        this.networkRequests.push(url);
      }
    });
  }

  async waitForNewContent(): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => console.log("Network idle timeout"));

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
      `output/captured_urls_${this.searchTerm}.json`,
      JSON.stringify([...new Set(this.networkRequests)], null, 2)
    );
  }
}

class ImageDownloader {
  static async downloadImage(url: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode === 200) {
          res
            .pipe(fs.createWriteStream(filePath))
            .on("error", reject)
            .once("close", () => resolve());
        } else {
          res.resume();
          reject(new Error(`Request Failed: ${res.statusCode}`));
        }
      });
    });
  }

  static async downloadAllImages(): Promise<void> {
    for (const term of SEARCH_TERMS) {
      const urlsFile = `output/captured_urls_${term}.json`;
      if (!fs.existsSync(urlsFile)) {
        console.log(`No URLs file found for ${term}`);
        continue;
      }

      const urls = JSON.parse(fs.readFileSync(urlsFile, "utf-8"));
      const saveDir = `./images/images_${term}`;

      console.log(`Downloading ${urls.length} images for ${term}`);
      for (let i = 0; i < urls.length; i++) {
        const fileName = `${term}-${i + 1}.png`;
        const filePath = path.join(saveDir, fileName);

        try {
          await this.downloadImage(urls[i], filePath);
          console.log(`Downloaded: ${fileName}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (err) {
          console.error(`Failed to download ${fileName}:`, err);
        }
      }
    }
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
    // Initialize directories before starting
    initializeDirectories();
    
    const { browser, context } = await this.initialize();
    const page = await context.newPage();

    try {
      // First collect all URLs
      for (const searchTerm of SEARCH_TERMS) {
        console.log(`Collecting URLs for: ${searchTerm}`);
        const pageHandler = new PageHandler(page, searchTerm);

        await page.goto(CONFIG.url, { waitUntil: "networkidle" });
        await page.waitForLoadState("domcontentloaded");

        await pageHandler.performSearch();
        await pageHandler.loadAllImages();
        await page.waitForTimeout(2000);
      }

      console.log("URL collection completed. Starting image downloads...");
      await ImageDownloader.downloadAllImages();

      console.log("All downloads completed!");
      await browser.close();
    } catch (error) {
      console.error("Error:", error);
      await browser.close();
      process.exit(1);
    }
  }
}

// Run the scraper
ImageScraper.run();