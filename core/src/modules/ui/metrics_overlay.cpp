#include "modules/metrics/metrics.h"
#include "modules/ui/ui.h"

#include <imgui.h>
#include <iomanip>
#include <ios>
#include <sstream>
#include <string>
#include <string_view>

namespace grav::ui {

namespace {

constexpr float METRICS_BG_ALPHA = 0.45F;

template <std::ios_base::fmtflags FLOAT_FORMAT, int PRECISION>
std::string metric_line(std::string_view label, double value) {
  std::ostringstream line;
  line << label;
  line.setf(FLOAT_FORMAT, std::ios_base::floatfield);
  line << std::setprecision(PRECISION) << value;
  return line.str();
}

} // namespace

void draw_metrics_overlay(const FrameMetrics& metrics, bool show_pairs) {
  constexpr float pad = 12.0F;
  const ImGuiViewport* viewport = ImGui::GetMainViewport();
  ImVec2 pos = viewport->WorkPos;
  pos.x += pad;
  pos.y += pad;
  ImGui::SetNextWindowPos(pos);
  ImGui::SetNextWindowBgAlpha(METRICS_BG_ALPHA);

  constexpr auto flags =
      static_cast<ImGuiWindowFlags>(static_cast<unsigned int>(ImGuiWindowFlags_NoDecoration) |
                                    static_cast<unsigned int>(ImGuiWindowFlags_AlwaysAutoResize) |
                                    static_cast<unsigned int>(ImGuiWindowFlags_NoSavedSettings) |
                                    static_cast<unsigned int>(ImGuiWindowFlags_NoFocusOnAppearing) |
                                    static_cast<unsigned int>(ImGuiWindowFlags_NoNav));

  if (ImGui::Begin("metrics", nullptr, flags)) {
    ImGui::TextUnformatted(
        metric_line<std::ios_base::fixed, 1>("fps:        ", metrics.fps).c_str());
    ImGui::TextUnformatted(
        (metric_line<std::ios_base::fixed, 2>("frame:      ", metrics.frame_time_ms) + " ms")
            .c_str());
    if (show_pairs) {
      ImGui::TextUnformatted(
          metric_line<std::ios_base::scientific, 2>("pairs/sec:  ", metrics.pairs_per_sec).c_str());
    }
  }
  ImGui::End();
}

} // namespace grav::ui
