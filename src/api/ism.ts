import { invoke } from "./invoke";

export type IsmProvider = { baseUrl: string };
export type IsmInfo = {
  instance_id: string;
  instance_name: string;
  api_version: number;
  roots: {
    root_id: string;
    name: string;
    available: boolean;
    direct_writes: "enabled" | "not_linked" | "blocked";
    direct_writes_reason?: string | null;
    direct_writes_detail?: string | null;
  }[];
};

export type IsmExpectedEntry = { path: string; revision: string };

export const getIsmProvider = (accountId: string) =>
  invoke<IsmProvider | null>("get_ism_provider", { accountId });
export const saveIsmProvider = (accountId: string, baseUrl: string, token: string | null) =>
  invoke<IsmInfo>("save_ism_provider", { accountId, baseUrl, token });
export const testIsmProvider = (accountId: string) =>
  invoke<IsmInfo>("test_ism_provider", { accountId });
export const removeIsmProvider = (accountId: string) =>
  invoke<void>("remove_ism_provider", { accountId });

export type IsmLocation = { root_id: string; path: string };
export type IsmOperation = { operation_id: string; status: string };
export type IsmActivity = {
  id: string;
  kind: string;
  label: string;
  status: string;
  error: string | null;
  createdAt: string;
};

export const getIsmImportFolder = (accountId: string) =>
  invoke<IsmLocation | null>("get_ism_import_folder", { accountId });
export const setIsmImportFolder = (accountId: string, folder: IsmLocation | null) =>
  invoke<void>("set_ism_import_folder", { accountId, folder });
export const ismRenameAsset = (assetId: string, newName: string) =>
  invoke<IsmOperation>("ism_rename_asset", { assetId, newName });
export const ismMoveAsset = (assetId: string, rootId: string | null, folder: string) =>
  invoke<IsmOperation>("ism_move_asset", { assetId, rootId, folder });
export const ismTrashAsset = (assetId: string) =>
  invoke<IsmOperation>("ism_trash_asset", { assetId });
export const ismCreateFolder = (accountId: string, rootId: string, path: string) =>
  invoke<IsmOperation>("ism_create_folder", { accountId, rootId, path });
export const ismMoveFolder = (
  accountId: string,
  rootId: string,
  path: string,
  targetRootId: string,
  targetPath: string,
) => invoke<IsmOperation>("ism_move_folder", { accountId, rootId, path, targetRootId, targetPath });
export const ismFolderSnapshot = (accountId: string, rootId: string, path: string) =>
  invoke<IsmExpectedEntry[]>("ism_folder_snapshot", { accountId, rootId, path });
export const ismTrashFolder = (
  accountId: string,
  rootId: string,
  path: string,
  expectedEntries: IsmExpectedEntry[],
) => invoke<IsmOperation>("ism_trash_folder", { accountId, rootId, path, expectedEntries });
export const listIsmActivity = () => invoke<IsmActivity[]>("ism_list_activity");
export const dismissIsmActivity = (id: string) => invoke<void>("ism_dismiss_activity", { id });
export const ismSupportedAssets = (assetIds: string[]) =>
  invoke<string[]>("ism_supported_assets", { assetIds });
export const ismFolderLocation = (accountId: string, path: string) =>
  invoke<IsmLocation | null>("ism_folder_location", { accountId, path });
