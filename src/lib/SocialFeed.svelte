<script>
  import { appState, actions } from './store.svelte.js';
  import { 
    MessageSquare, 
    Heart, 
    Share2, 
    Image, 
    Tag, 
    Camera, 
    Volume2, 
    AlertCircle 
  } from '@lucide/svelte';

  let newPostText = $state('');
  let postTag = $state('Mailday'); // 'Mailday', 'Review', 'Trade'
  let mockImageUrl = $state('');

  function handleAddPost() {
    if (!newPostText.trim()) return;
    
    // Auto attach some cool vinyl images if tag is mailday and no image supplied
    let img = mockImageUrl;
    if (!img && postTag === 'Mailday') {
      const covers = [
        'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=600&q=80',
        'https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=600&q=80'
      ];
      img = covers[Math.floor(Math.random() * covers.length)];
    }

    const fullContent = `[${postTag}] ${newPostText}`;
    actions.addFeedPost(fullContent, img);

    // Reset fields
    newPostText = '';
    mockImageUrl = '';
  }

  function toggleLike(id) {
    actions.likePost(id);
  }
</script>

<div class="space-y-6">
  <div class="space-y-1 text-center sm:text-left">
    <h1 class="text-3xl font-bold tracking-tight">Collector Feeds</h1>
    <p class="text-sm text-neutral-content">
      Showcase your vinyl arrivals, review pressing qualities, and post variant trade offers with local crate diggers.
    </p>
  </div>

  <!-- Posting card -->
  <div class="card bg-base-200 border border-base-300 shadow-xl">
    <div class="card-body p-5 space-y-4">
      <h2 class="text-lg font-bold flex items-center gap-2">
        <Camera class="h-5 w-5 text-primary" />
        Post Crate Update
      </h2>
      
      <div class="space-y-3">
        <textarea 
          class="textarea textarea-bordered w-full h-24" 
          placeholder="What's spinning today? Share variant details, catalog numbers or trade requests..." 
          bind:value={newPostText}
        ></textarea>
        
        <div class="flex flex-wrap gap-2 justify-between items-center">
          <div class="flex flex-wrap items-center gap-2">
            <!-- Tag selection -->
            <div class="join">
              <button 
                onclick={() => postTag = 'Mailday'} 
                class="btn btn-sm join-item {postTag === 'Mailday' ? 'btn-primary' : 'btn-neutral'}"
              >
                Mailday
              </button>
              <button 
                onclick={() => postTag = 'Review'} 
                class="btn btn-sm join-item {postTag === 'Review' ? 'btn-secondary' : 'btn-neutral'}"
              >
                Review
              </button>
              <button 
                onclick={() => postTag = 'Trade'} 
                class="btn btn-sm join-item {postTag === 'Trade' ? 'btn-accent' : 'btn-neutral'}"
              >
                Trade
              </button>
            </div>
            
            <!-- Image mock URL toggle -->
            <input 
              type="text" 
              placeholder="Jacket Image URL (optional)" 
              class="input input-bordered input-sm w-44 md:w-60" 
              bind:value={mockImageUrl}
            />
          </div>

          <button onclick={handleAddPost} class="btn btn-primary btn-sm px-6 neon-glow-primary w-full sm:w-auto">
            Publish Post
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Social Stream -->
  <div class="space-y-6 max-w-2xl mx-auto">
    {#each appState.feedPosts as post (post.id)}
      <div class="card bg-base-200 border border-base-300 shadow-xl overflow-hidden">
        <!-- Post Header -->
        <div class="p-5 flex items-center justify-between border-b border-base-300/40">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full border border-base-300 overflow-hidden bg-base-300">
              <img src={post.avatar} alt="User Avatar" class="w-full h-full object-cover" />
            </div>
            <div>
              <h3 class="font-bold text-sm leading-none">{post.user}</h3>
              <span class="text-[10px] text-neutral-content">{post.time}</span>
            </div>
          </div>
          
          <!-- Determine visual tags -->
          {#if post.content.startsWith('[Mailday]')}
            <span class="badge badge-primary badge-sm">Mailday Reveal</span>
          {:else if post.content.startsWith('[Review]')}
            <span class="badge badge-secondary badge-sm">Press Review</span>
          {:else if post.content.startsWith('[Trade]')}
            <span class="badge badge-accent badge-sm">Trade Request</span>
          {:else}
            <span class="badge badge-neutral badge-sm">General</span>
          {/if}
        </div>

        <!-- Post Body -->
        <div class="p-5 space-y-4">
          <!-- Filtered content text (removing prefix for display) -->
          <p class="text-sm leading-relaxed text-base-content font-medium">
            {post.content.replace(/^\[(Mailday|Review|Trade)\]\s*/, '')}
          </p>

          <!-- Post image -->
          {#if post.image}
            <div class="rounded-xl overflow-hidden border border-base-300 max-h-96">
              <img src={post.image} alt="Mailday attachment" class="w-full h-full object-cover" />
            </div>
          {/if}
        </div>

        <!-- Post Actions -->
        <div class="px-5 py-3 bg-base-300/40 border-t border-base-300/50 flex justify-between items-center">
          <div class="flex gap-4">
            <!-- Like Button -->
            <button 
              onclick={() => toggleLike(post.id)}
              class="flex items-center gap-1.5 text-xs font-semibold transition-colors {post.hasLiked ? 'text-error' : 'text-neutral-content hover:text-error'}"
            >
              <Heart class="h-4 w-4 {post.hasLiked ? 'fill-error' : ''}" />
              <span>{post.likes} Likes</span>
            </button>

            <!-- Comment Button -->
            <div class="flex items-center gap-1.5 text-xs text-neutral-content">
              <MessageSquare class="h-4 w-4" />
              <span>{post.comments} Comments</span>
            </div>
          </div>

          <button class="btn btn-ghost btn-xs text-neutral-content gap-1">
            <Share2 class="h-3.5 w-3.5" />
            Share
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>
