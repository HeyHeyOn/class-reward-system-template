'use client';

import { useRef, useState } from 'react';
import type { AdminTab, StoreTab } from './adminTypes';
import type { IconName } from '../ui';

export const storeTabs: StoreTab[] = ['inventory', 'promotions'];

export const tabs: Array<{ id: AdminTab; label: string; icon: IconName }> = [
  { id: 'home', label: '홈', icon: 'home' },
  { id: 'students', label: '학생', icon: 'users' },
  { id: 'products', label: '매점', icon: 'store' },
  { id: 'tasks', label: '과제', icon: 'task' },
  { id: 'tree', label: '나무 키우기', icon: 'sprout' },
  { id: 'pets', label: '펫 키우기', icon: 'paw' },
  { id: 'currency', label: '지급·회수', icon: 'coins' },
  { id: 'transactions', label: '거래 내역', icon: 'receipt' },
  { id: 'settings', label: '설정', icon: 'settings' },
];

export function useAdminNavigation() {
  const [activeTab, setActiveTab] = useState<AdminTab>('home');
  const adminTabRefs = useRef<Partial<Record<AdminTab, HTMLButtonElement | null>>>({});
  const [storeTab, setStoreTab] = useState<StoreTab>('inventory');
  const [hasOpenedPromotions, setHasOpenedPromotions] = useState(false);
  const [hasOpenedTransactions, setHasOpenedTransactions] = useState(false);
  const storeTabRefs = useRef<Record<StoreTab, HTMLButtonElement | null>>({ inventory: null, promotions: null });

  function selectAdminTab(nextTab: AdminTab, focus = false) {
    setActiveTab(nextTab);
    if (nextTab === 'transactions') setHasOpenedTransactions(true);
    if (focus) adminTabRefs.current[nextTab]?.focus();
  }

  function handleAdminTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: AdminTab) {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    let nextTab: AdminTab | undefined;
    if (event.key === 'ArrowRight') nextTab = tabs[(currentIndex + 1) % tabs.length].id;
    if (event.key === 'ArrowLeft') nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length].id;
    if (event.key === 'Home') nextTab = tabs[0].id;
    if (event.key === 'End') nextTab = tabs[tabs.length - 1].id;
    if (!nextTab) return;
    event.preventDefault();
    selectAdminTab(nextTab, true);
  }

  function selectStoreTab(nextTab: StoreTab, focus = false) {
    setStoreTab(nextTab);
    if (nextTab === 'promotions') setHasOpenedPromotions(true);
    if (focus) storeTabRefs.current[nextTab]?.focus();
  }

  function handleStoreTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: StoreTab) {
    const currentIndex = storeTabs.indexOf(currentTab);
    let nextTab: StoreTab | undefined;
    if (event.key === 'ArrowRight') nextTab = storeTabs[(currentIndex + 1) % storeTabs.length];
    if (event.key === 'ArrowLeft') nextTab = storeTabs[(currentIndex - 1 + storeTabs.length) % storeTabs.length];
    if (event.key === 'Home') nextTab = storeTabs[0];
    if (event.key === 'End') nextTab = storeTabs[storeTabs.length - 1];
    if (!nextTab) return;
    event.preventDefault();
    selectStoreTab(nextTab, true);
  }

  return { activeTab, storeTab, adminTabRefs, storeTabRefs, hasOpenedPromotions, hasOpenedTransactions, selectAdminTab, selectStoreTab, handleAdminTabKeyDown, handleStoreTabKeyDown };
}
