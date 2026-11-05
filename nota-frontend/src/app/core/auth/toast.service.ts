import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** Stage 14: small app-wide toasts (permission refused, session messages). Shown by <nota-toasts>. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  readonly toasts = signal<Toast[]>([]);

  show(text: string, kind: ToastKind = 'info', ms = 5000): void {
    if (!text) return;
    // The same text twice in a row (e.g. two parallel requests refused) shows once.
    if (this.toasts().some((toast) => toast.text === text)) return;
    const toast = { id: this.nextId++, kind, text };
    this.toasts.update((list) => [...list, toast]);
    if (ms > 0) setTimeout(() => this.dismiss(toast.id), ms);
  }

  error(text: string): void {
    this.show(text, 'error');
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((toast) => toast.id !== id));
  }
}
