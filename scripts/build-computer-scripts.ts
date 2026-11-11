import { writeComputerScripts } from "./computer-scripts.ts";

writeComputerScripts(new URL("../dist/computer/drivers/", import.meta.url));
