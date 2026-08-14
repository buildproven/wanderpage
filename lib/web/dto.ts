import type { Story } from "@/lib/web/types";

export function storyDto(story: Story) {
  const { admissionKey: _admissionKey, ...dto } = story;
  void _admissionKey;
  return dto;
}
