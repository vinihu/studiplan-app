import type { IpcHandlers } from "@shared/ipc";
import { buildPromptContent } from "../extract";
import { prepareMaterial } from "../study/material";
import { createStudyService } from "../study/service";
import type { StudyService } from "../study/service";
import { getContext } from "./context";
import { emit } from "./events";

/**
 * The `study` namespace of the bridge: making results and keeping them. The work, and the
 * checking of every argument, is in `src/main/study/service.ts`.
 */
let service: StudyService | null = null;

export function getStudyService(): StudyService {
  return getService();
}

function getService(): StudyService {
  if (service) return service;
  const { extractor, library, providers, settings, tasks } = getContext();
  service = createStudyService({
    // The material's files are read in the stoppable worker, like everywhere else.
    prepare: (material, provider, options) =>
      prepareMaterial(material, provider, {
        buildContent: (files, contentOptions) =>
          buildPromptContent(files, { ...contentOptions, extract: (kind, path, extractOptions) => extractor.extractText(kind, path, extractOptions) }),
        countPages: (path, countOptions) => extractor.countPdfPages(path, countOptions),
        ...options,
      }),
    library,
    registry: providers,
    settings,
    tasks,
    progress: (progress) => emit("taskProgress", progress),
  });
  return service;
}

export const studyHandlers: IpcHandlers["study"] = {
  generate: (ref, request) => getService().generate(ref, request),
  current: () => getService().current(),
  list: (ref) => getService().list(ref),
  read: (ref, name) => getService().read(ref, name),
  rename: (ref, name, title) => getService().rename(ref, name, title),
  remove: (ref, name) => getService().remove(ref, name),
};
