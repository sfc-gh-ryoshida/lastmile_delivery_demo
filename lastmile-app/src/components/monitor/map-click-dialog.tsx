"use client";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { AlertTriangle } from "lucide-react";

interface ClickCoordinate {
  lat: number;
  lng: number;
}

interface Props {
  coordinate: ClickCoordinate | null;
  onConfirm: (coord: ClickCoordinate) => void;
  onCancel: () => void;
}

export function MapClickDialog({ coordinate, onConfirm, onCancel }: Props) {
  return (
    <AlertDialog open={!!coordinate} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            地図アクション
          </AlertDialogTitle>
          <AlertDialogDescription>
            この地点で事故シミュレーションを実行しますか？
            {coordinate && (
              <span className="mt-1 block font-mono text-[10px]">
                ({coordinate.lat.toFixed(5)}, {coordinate.lng.toFixed(5)})
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => coordinate && onConfirm(coordinate)}
          >
            シミュレーション実行
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
