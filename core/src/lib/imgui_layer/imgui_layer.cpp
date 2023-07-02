#include "lib/imgui_layer/imgui_layer.h"

#include <imgui.h>

#include <backends/imgui_impl_glfw.h>
#include <backends/imgui_impl_opengl3.h>

#include "error.h"

namespace grav::imgui {

namespace {

constexpr const char* kGlslVersion = "#version 410 core";

}

Session::Session(GLFWwindow* window, float dpi_scale) {
    IMGUI_CHECKVERSION();
    if (ImGui::CreateContext() == nullptr) {
        throw AppError::dependency_unavailable("imgui: CreateContext failed");
    }

    ImGuiIO& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.IniFilename = nullptr;

    if (dpi_scale > 1.0F) {
        ImGui::GetStyle().ScaleAllSizes(dpi_scale);
        io.FontGlobalScale = dpi_scale;
    }

    if (!ImGui_ImplGlfw_InitForOpenGL(window, true)) {
        ImGui::DestroyContext();
        throw AppError::dependency_unavailable("imgui: glfw backend init failed");
    }

    if (!ImGui_ImplOpenGL3_Init(kGlslVersion)) {
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

}
