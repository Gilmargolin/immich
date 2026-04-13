type NotificationType = 'success' | 'info' | 'warning' | 'danger';

type NotificationAction = {
  label: string;
  onClick: () => void;
};

type Notification = {
  message: string;
  type: NotificationType;
  action?: NotificationAction;
};

class NotificationBarManager {
  current = $state<Notification | null>(null);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #batchKey: string | null = null;
  #batchCount = 0;
  #batchedUndoFns: Array<() => void> = [];

  show(message: string, type: NotificationType = 'success', timeout = 3000) {
    this.#clearBatch();
    this.current = { message, type };
    this.#resetTimer(timeout);
  }

  showWithAction(
    message: string,
    action: NotificationAction,
    type: NotificationType = 'success',
    timeout = 5000,
  ) {
    this.#clearBatch();
    this.current = { message, type, action };
    this.#resetTimer(timeout);
  }

  showBatched(opts: {
    batchKey: string;
    count: number;
    messageFn: (count: number) => string;
    undoFn?: () => void;
    undoLabel?: string;
    type?: NotificationType;
    timeout?: number;
  }) {
    const type = opts.type ?? 'success';
    const timeout = opts.timeout ?? 5000;

    if (this.#batchKey === opts.batchKey && this.current) {
      this.#batchCount += opts.count;
      if (opts.undoFn) {
        this.#batchedUndoFns.push(opts.undoFn);
      }
    } else {
      this.#batchKey = opts.batchKey;
      this.#batchCount = opts.count;
      this.#batchedUndoFns = opts.undoFn ? [opts.undoFn] : [];
    }

    const allUndoFns = [...this.#batchedUndoFns];
    this.current = {
      message: opts.messageFn(this.#batchCount),
      type,
      action:
        allUndoFns.length > 0 && opts.undoLabel
          ? {
              label: opts.undoLabel,
              onClick: () => {
                for (const fn of allUndoFns) fn();
              },
            }
          : undefined,
    };
    this.#resetTimer(timeout);
  }

  dismiss() {
    this.current = null;
    this.#clearBatch();
  }

  #clearBatch() {
    this.#batchKey = null;
    this.#batchCount = 0;
    this.#batchedUndoFns = [];
  }

  #resetTimer(timeout: number) {
    if (this.#timer) clearTimeout(this.#timer);
    if (timeout > 0) {
      this.#timer = setTimeout(() => this.dismiss(), timeout);
    }
  }
}

export const notificationBar = new NotificationBarManager();
