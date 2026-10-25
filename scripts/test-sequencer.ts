import { resolve } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export class FileOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!process.env.ROLEBOX_TEST_FILE_ORDER) return super.sort(files);
    const paths = JSON.parse(process.env.ROLEBOX_TEST_FILE_ORDER) as string[];
    const normalize = (path: string) => resolve(path).replaceAll("\\", "/");
    const order = new Map(paths.map((path, index) => [normalize(path), index]));
    if (files.length !== paths.length || files.some(file => !order.has(normalize(file.moduleId)))) {
      throw new Error("Explicit test order must name every selected test file exactly once");
    }
    return [...files].sort((left, right) => order.get(normalize(left.moduleId))! - order.get(normalize(right.moduleId))!);
  }
}
