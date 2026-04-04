const lidsTop = document.querySelectorAll('.lid-top');
const lidsBottom = document.querySelectorAll('.lid-bottom');
const irisGroups = document.querySelectorAll('.iris-group');

let currentEmotion = 'neutral';
let lookX = 0;
let lookY = 0;

// Emotion-based styles
const EMOTIONS = {
  neutral: { lookScale: 1.0, irisColor: '#1dd6c3' },
  happy: { lookScale: 1.1, irisColor: '#7ef5ea' },
  excited: { lookScale: 1.3, irisColor: '#00ffcc' },
  surprised: { lookScale: 1.5, irisColor: '#ffffff' },
  curious: { lookScale: 0.9, irisColor: '#1dd6c3' },
  focused: { lookScale: 0.8, irisColor: '#00ccff' },
  sleepy: { lookScale: 0.7, irisColor: '#16a091' },
  alert: { lookScale: 1.2, irisColor: '#ffaa00' }
};

// Blinking logic
function blink() {
  const duration = Math.random() * 50 + 80; // 80-130ms blink
  
  lidsTop.forEach(lid => lid.setAttribute('height', '50'));
  lidsBottom.forEach(lid => {
    lid.setAttribute('height', '50');
    lid.setAttribute('y', '50');
  });

  setTimeout(() => {
    lidsTop.forEach(lid => lid.setAttribute('height', '0'));
    lidsBottom.forEach(lid => {
      lid.setAttribute('height', '0');
      lid.setAttribute('y', '100');
    });
  }, duration);
}

function scheduleBlink() {
  const nextBlink = Math.random() * 4000 + 2000; // 2-6 seconds
  setTimeout(() => {
    blink();
    // Occasional double blink
    if (Math.random() < 0.2) {
      setTimeout(blink, 150);
    }
    scheduleBlink();
  }, nextBlink);
}

// Saccades and Gaze
function updateGaze() {
  // Move eyes slightly and randomly
  const saccadeX = (Math.random() - 0.5) * 4;
  const saccadeY = (Math.random() - 0.5) * 4;
  
  const targetX = (lookX * 15) + saccadeX;
  const targetY = (lookY * 15) + saccadeY;
  
  irisGroups.forEach(group => {
    group.style.transform = `translate(${targetX}px, ${targetY}px)`;
  });

  // Next saccade
  setTimeout(updateGaze, Math.random() * 800 + 400);
}

// Simple emotion poll (can be replaced with WebSocket)
async function checkEmotion() {
  try {
    // Assuming the Mac server is reachable at this IP (from .env)
    const response = await fetch('http://192.168.1.34:3000/api/status'); // Hypothetical status endpoint
    const data = await response.json();
    if (data.emotion && data.emotion !== currentEmotion) {
      currentEmotion = data.emotion;
      console.log("Emotion changed:", currentEmotion);
      // Apply emotion-specific visual changes if any
    }
  } catch (e) {
    // Silently fail if server is down
  }
  setTimeout(checkEmotion, 1000);
}

// Init
scheduleBlink();
updateGaze();
// checkEmotion(); // Uncomment when backend endpoint is ready
