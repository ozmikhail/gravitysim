#include "lib/imgui_layer/imgui_layer.h"

#include "error.h"

#include <backends/imgui_impl_glfw.h>
#include <backends/imgui_impl_opengl3.h>
#include <imgui.h>

namespace grav::imgui {

namespace {

constexpr const char* GLSL_VERSION = "#version 410 core";

}

Session::Session(GLFWwindow* window, float dpi_scale) {
  IMGUI_CHECKVERSION();
  if (ImGui::CreateContext() == nullptr) {
    throw AppError::dependency_unavailable("imgui: CreateContext failed");
  }

  ImGuiIO& imgui_io = ImGui::GetIO();
  imgui_io.ConfigFlags =
      static_cast<int>(static_cast<unsigned int>(imgui_io.ConfigFlags) |
                       static_cast<unsigned int>(ImGuiConfigFlags_NavEnableKeyboard));
  imgui_io.IniFilename = nullptr;

  if (dpi_scale > 1.0F) {
    ImGui::GetStyle().ScaleAllSizes(dpi_scale);
    imgui_io.FontGlobalScale = dpi_scale;
  }

  if (!ImGui_ImplGlfw_InitForOpenGL(window, true)) {
    ImGui::DestroyContext();
    throw AppError::dependency_unavailable("imgui: glfw backend init failed");
  }

  if (!ImGui_ImplOpenGL3_Init(GLSL_VERSION)) {
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    throw AppError::dependency_unavailable("imgui: opengl3 backend init failed");
  }
}

Session::~Session() {
  ImGui_ImplOpenGL3_Shutdown();
  ImGui_ImplGlfw_Shutdown();
  ImGui::DestroyContext();
}

void begin_frame() {
  ImGui_ImplOpenGL3_NewFrame();
  ImGui_ImplGlfw_NewFrame();
  ImGui::NewFrame();
}

void end_frame() {
  ImGui::Render();
  ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
}

} // namespace grav::imgui
