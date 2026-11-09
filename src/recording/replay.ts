import type { RecordingStep } from "./recorder.ts";

export function recordingReplay(steps: readonly RecordingStep[], hasVideo: boolean): string {
  const data = JSON.stringify(steps).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Operation recording</title>
<style>body{margin:24px auto;padding:0 20px;max-width:1200px;font:16px system-ui;background:#101820;color:#edf2f4}video{width:100%;max-height:70vh;background:#000}button{display:block;width:100%;padding:10px;text-align:left;color:inherit;background:transparent;border:0;border-bottom:1px solid #35424b;cursor:pointer}button:hover,button[aria-current=true]{background:#243743}small{color:#b9c8d1}</style>
<h1>Operation recording</h1>
${hasVideo ? '<video id="video" controls preload="metadata" src="recording.mp4"></video>' : '<p>Video encoding failed. Captured frames and frames.ffconcat are available for recovery.</p>'}
<p><small>Select a step to seek to its start. Times include tool queue and execution time. Input text is omitted from the timeline; visible content remains in the video.</small></p>
<nav id="steps" aria-label="Operation timeline"></nav>
<script>
const steps=${data};
const video=document.getElementById('video');
const container=document.getElementById('steps');
for(const step of steps){
  const button=document.createElement('button');
  button.textContent=(step.start_ms/1000).toFixed(2)+'s · '+step.tool+' · '+(step.success===null?'incomplete':step.success?'ok':'failed')+' · '+JSON.stringify(step.arguments);
  button.onclick=()=>{if(video)video.currentTime=step.start_ms/1000};
  container.append(button);
}
if(video)video.ontimeupdate=()=>{
  let active=-1;
  for(let i=0;i<steps.length;i++)if(steps[i].start_ms<=video.currentTime*1000)active=i;
  for(let i=0;i<container.children.length;i++)container.children[i].setAttribute('aria-current',String(i===active));
};
</script></html>`;
}
