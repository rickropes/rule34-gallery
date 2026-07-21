import { invoke } from "@tauri-apps/api/core";

export interface MobileQueueSettings { endpoint: string; token: string }
export interface MobileSyncResult { fetched: number; imported: number; failed: number; messages: string[] }
export const getMobileQueueSettings=()=>invoke<MobileQueueSettings>("get_mobile_queue_settings");
export const setMobileQueueSettings=(endpoint:string,token:string)=>invoke<void>("set_mobile_queue_settings",{endpoint,token});
export const syncMobileQueue=()=>invoke<MobileSyncResult>("sync_mobile_queue");
