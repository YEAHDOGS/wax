/**
 * Reddit API Wrapper Service for WaxOnWax
 * Fetches real-time drops from r/VinylReleases and r/vinyl and parses them.
 */

// Common Reddit slang replacements, inspired by VidsVidsVids/data.js
function replaceRedditSlang(text) {
  if (!text) return '';
  text = text.replace(/AITA/gi, 'Am I The Asshole');
  text = text.replace(/TIFU/gi, "Today I Fudged Up");
  text = text.replace(/tldr|tl;dr/gi, 'In other words,');
  text = text.replace(/\bIRL\b/gi, 'In Real Life');
  text = text.replace(/\bTBH\b/gi, 'To Be Honest');
  return text;
}

// Clean up weird formatting and symbols
export function sanitizeText(text) {
  if (!text) return '';
  let cleaned = replaceRedditSlang(text);
  // Remove emojis
  cleaned = cleaned.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
  // Clean special quote characters
  cleaned = cleaned.replace(/['"’‘“”]/g, "'");
  return cleaned.trim();
}

/**
 * Attempts to parse standard r/VinylReleases titles.
 * Format: "Artist - Album Title (Variant Info) [Retailer]"
 */
export function parseVinylTitle(title) {
  const result = {
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    variant: 'Standard Black Pressing',
    retailer: 'General Release'
  };

  if (!title) return result;
  
  // Clean raw title
  const cleanTitle = title.replace(/\s+/g, ' ').trim();

  // 1. Try to split by artist - album delimiter
  let remaining = cleanTitle;
  const hyphenIndex = cleanTitle.indexOf(' - ');
  if (hyphenIndex !== -1) {
    result.artist = cleanTitle.substring(0, hyphenIndex).trim();
    remaining = cleanTitle.substring(hyphenIndex + 3).trim();
  } else {
    // If no hyphen, look for colon
    const colonIndex = cleanTitle.indexOf(': ');
    if (colonIndex !== -1) {
      result.artist = cleanTitle.substring(0, colonIndex).trim();
      remaining = cleanTitle.substring(colonIndex + 2).trim();
    }
  }

  // 2. Parse brackets [Retailer/Details]
  const bracketMatches = [...remaining.matchAll(/\[(.*?)\]/g)];
  if (bracketMatches.length > 0) {
    result.retailer = bracketMatches.map(m => m[1]).join(', ');
    // Remove brackets from remaining text
    remaining = remaining.replace(/\[.*?\]/g, '').trim();
  }

  // 3. Parse parentheses (Variant details)
  const parenMatches = [...remaining.matchAll(/\((.*?)\)/g)];
  if (parenMatches.length > 0) {
    result.variant = parenMatches.map(m => m[1]).join(', ');
    // Remove parentheses from remaining text
    remaining = remaining.replace(/\(.*?\)/g, '').trim();
  }

  // 4. Whatever is left in remaining is the album title
  remaining = remaining.replace(/\s+/g, ' ').trim();
  if (remaining) {
    result.album = remaining;
  } else if (result.artist !== 'Unknown Artist') {
    // Fallback if split was messy
    result.album = result.artist;
    result.artist = 'Various Artists';
  }

  // Clean parsed values
  result.artist = sanitizeText(result.artist);
  result.album = sanitizeText(result.album);
  result.variant = sanitizeText(result.variant);
  result.retailer = sanitizeText(result.retailer);

  return result;
}

/**
 * Fetch hot/new posts from subreddits
 */
export async function fetchRedditDrops(subreddits = ['VinylReleases', 'vinyl'], favorites = [], keywords = []) {
  const allDrops = [];

  for (const sub of subreddits) {
    try {
      const response = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=30`);
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const json = await response.json();
      const children = json?.data?.children || [];

      children.forEach(child => {
        const post = child.data;
        if (!post.title) return;

        // Skip non-releases or self posts on r/vinyl that aren't releases
        if (sub === 'vinyl' && !post.title.toLowerCase().includes('release') && !post.title.toLowerCase().includes('drop') && !post.title.toLowerCase().includes('vinyl')) {
          // Keep only relevance on r/vinyl
          return;
        }

        const parsed = parseVinylTitle(post.title);
        
        // Determine matching status
        let isMatched = false;
        let matchReason = '';

        // Check favorite artists
        const artistMatch = favorites.find(artist => 
          parsed.artist.toLowerCase().includes(artist.toLowerCase()) ||
          post.title.toLowerCase().includes(artist.toLowerCase())
        );

        if (artistMatch) {
          isMatched = true;
          matchReason = `Favorite Artist: "${artistMatch}"`;
        }

        // Check custom keywords
        if (!isMatched && keywords.length > 0) {
          const keywordMatch = keywords.find(kw => 
            post.title.toLowerCase().includes(kw.toLowerCase()) ||
            (post.selftext && post.selftext.toLowerCase().includes(kw.toLowerCase()))
          );
          if (keywordMatch) {
            isMatched = true;
            matchReason = `Keyword Match: "${keywordMatch}"`;
          }
        }

        allDrops.push({
          id: post.id,
          title: post.title,
          artist: parsed.artist,
          album: parsed.album,
          variant: parsed.variant,
          retailer: parsed.retailer,
          url: post.url || `https://reddit.com${post.permalink}`,
          permalink: `https://reddit.com${post.permalink}`,
          subreddit: sub,
          createdUtc: post.created_utc * 1000, // to MS
          thumbnail: post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : null,
          isMatched,
          matchReason,
          selftext: post.selftext,
          flair: post.link_flair_text || ''
        });
      });
    } catch (error) {
      console.error(`Failed to fetch r/${sub} drops:`, error);
    }
  }

  // Sort by date newest first
  return allDrops.sort((a, b) => b.createdUtc - a.createdUtc);
}
