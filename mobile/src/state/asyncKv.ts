import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValue } from './kv.ts';

export const asyncKv: KeyValue = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};
