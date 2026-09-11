// A custom hook that warns about console.log in edited files
export default {
  onToolAfter: (ctx, { tool, args, output }) => {
    if (tool !== "write" && tool !== "edit") return;
    const content = typeof args?.content === "string" ? args.content : "";
    if (content.includes("console.log(")) {
      ctx.inject(`<system-reminder>Warning: console.log() detected in ${tool} output. Consider removing debug statements.</system-reminder>`);
    }
  },
};
