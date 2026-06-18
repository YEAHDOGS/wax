# WaxOnWax 🎧

> The autonomous vinyl tracking engine and social hub for crate diggers.

WaxOnWax eliminates the frustration of missing out on limited-edition vinyl drops, colored variants, and exclusive pressings. By turning manual forum-combing into a real-time, low-latency notification pipeline, WaxOnWax ensures you never miss a release from your favorite artists. Combined with digital collection cataloging and custom achievements, it's the ultimate platform for serious vinyl collectors.

---

## 🚀 Core Features

### 1. Real-Time Drop Alerts (The Engine)
* **Subreddit Scraping:** Automated, low-latency monitoring of `r/VinylReleases` and `r/vinyl` via API/Scraping workers.
* **Instant Notifications:** Immediate routing of matched artist drops to users via SMS (Twilio) and Email (Resend).
* **Keyword Matching:** Advanced filtering to catch specific keywords like "Limited Edition", "Liquid Filled", "Numbered", or specific colorways.

### 2. Digital Crate Cataloging (The Social Layer)
* **Virtual Collection:** Users can catalog their physical vinyl libraries, showcase rare variants, and display their current heavy rotation.
* **Collector Feeds:** A specialized social feed where collectors can share photos of their maildays, discuss pressing quality, and trade variants.

### 3. Gamification & Achievements (The Flex)
* **Dynamic Badges:** Earn custom digital achievements for collection milestones (e.g., *Color Variant King*, *Discogs Power User*, *First Press Fanatic*).
* **Collection Stats:** Beautifully visualized data breakdowns of your library by genre, color profile, and release era.

---

## 🛠️ Tech Stack

* **Frontend:** Svelte + Vite (Lightning-fast reactivity and build times)
* **Styling:** TailwindCSS + SCSS (Utility-first framework supercharged with structured nesting and variables)
* **Backend/Database:** Supabase (PostgreSQL for user data, collection storage, and real-time synchronization)
* **Background Workers:** Node.js / Python cron workers for continuous forum ingestion.
* **APIs:** Reddit JSON API, Twilio API (SMS), Resend API (Email), Discogs API (Metadata parsing).

---

## 🎯 Getting Started

### Prerequisites
* Node.js (v18 or higher)
* A Supabase project instance
* Reddit API credentials

### Installation
1. Clone the repository:
```bash
   git clone [https://github.com/yourusername/waxonwax.git](https://github.com/yourusername/waxonwax.git)
   cd waxonwax
