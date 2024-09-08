#include "modules/ui/ui.h"

#include <imgui.h>

namespace grav::ui {

void draw_metrics_overlay(const FrameMetrics& metrics, bool show_pairs) {
    constexpr float pad = 12.0F;
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImVec2 pos = viewport->WorkPos;
    pos.x += pad;
    pos.y += pad;
    ImGui::SetNextWindowPos(pos);
    ImGui::SetNextWindowBgAlpha(0.45F);

    constexpr ImGuiWindowFlags flags =
        ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize |
        ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing |
        ImGuiWindowFlags_NoNav;

    if (ImGui::Begin("metrics", nullptr, flags)) {
        ImGui::Text("fps:        %.1f", metrics.fps);
        ImGui::Text("frame:      %.2f ms", metrics.frame_time_ms);
        if (show_pairs) {
            ImGui::Text("pairs/sec:  %.2e", metrics.pairs_per_sec);
        }
    }
    ImGui::End();
}

}
