<script>
  /**
   * MatrixText.svelte
   * Renders a typewriter typing animation with digital glitch letters (matrix effect)
   * resolving to the final text, triggered whenever the text prop updates.
   */
  let { text = '', speed = 35 } = $props();

  let displayedText = $state('');
  let isAnimating = $state(false);

  $effect(() => {
    if (!text) {
      displayedText = '';
      isAnimating = false;
      return;
    }

    const target = text;
    const length = target.length;
    let frame = 0;
    const maxFrames = length + 4; // allow a small tail of glitching
    isAnimating = true;

    const matrixChars = '01$@B%&WM#*<>[]{}_-+=?|/\\';
    
    const interval = setInterval(() => {
      if (frame >= maxFrames) {
        displayedText = target;
        isAnimating = false;
        clearInterval(interval);
        return;
      }

      let current = '';
      for (let i = 0; i < length; i++) {
        if (i < frame - 2) {
          // Resolved character
          current += target[i];
        } else if (i <= frame) {
          // Glitching character at decoding boundary
          if (target[i] === ' ') {
            current += ' ';
          } else {
            current += matrixChars[Math.floor(Math.random() * matrixChars.length)];
          }
        } else {
          // Empty or hidden until reached
          current += '';
        }
      }

      displayedText = current;
      frame++;
    }, speed);

    return () => {
      clearInterval(interval);
    };
  });
</script>

<span class="font-mono tracking-wider">{displayedText}</span>{#if isAnimating}<span class="typing-cursor"></span>{/if}
