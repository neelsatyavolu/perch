from pathlib import Path

import pytest

from perchtools.components import (
    KNOWN_FILE,
    REGISTRATION_CC,
    ComponentsError,
    check_components,
    new_component_reasons,
    registration_calls,
    write_known,
)

REGISTRATION = """
void Other() { RegisterIgnoredComponent(cus); }

void RegisterComponentsForUpdate() {
  auto* cus = g_browser_process->component_updater();
  if (google) {
    RegisterOptimizationHintsComponent(cus);
  }
  // RegisterCommentedOutComponent(cus);
  /* MaybeRegisterBlockComment(cus); */
  MaybeRegisterPKIMetadataComponent(cus);
  RegisterCRLSetComponent(cus);
  RegisterCRLSetComponent(cus);
  perch::RegisterPerchComponent(cus);
  component_updater::ManageScreenAIComponentRegistration(cus, prefs);
}
"""


def _src(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "src" / REGISTRATION_CC
    path.parent.mkdir(parents=True)
    path.write_text(text)
    return tmp_path / "src"


def test_calls_are_distinct_sorted_and_skip_comments_perch_and_other_functions():
    assert registration_calls(REGISTRATION) == [
        "ManageScreenAIComponentRegistration",
        "MaybeRegisterPKIMetadataComponent",
        "RegisterCRLSetComponent",
        "RegisterOptimizationHintsComponent",
    ]


def test_missing_function_is_an_error():
    with pytest.raises(ComponentsError, match="moved it"):
        registration_calls("void Something() {}")


def test_update_then_check_is_clean(tmp_path):
    src = _src(tmp_path, REGISTRATION)
    write_known(tmp_path, src)
    diff = check_components(tmp_path, src)
    assert diff.new == () and diff.gone == ()


def test_new_and_removed_calls_are_reported(tmp_path):
    src = _src(tmp_path, REGISTRATION)
    write_known(tmp_path, src)
    (src / REGISTRATION_CC).write_text(
        REGISTRATION.replace("RegisterCRLSetComponent", "RegisterBrandNewComponent")
    )
    diff = check_components(tmp_path, src)
    assert diff.new == ("RegisterBrandNewComponent",)
    assert diff.gone == ("RegisterCRLSetComponent",)
    [reason] = new_component_reasons(diff)
    assert "RegisterBrandNewComponent" in reason and "privacy-components.patch" in reason


def test_missing_known_file_is_an_error(tmp_path):
    src = _src(tmp_path, REGISTRATION)
    with pytest.raises(ComponentsError, match=str(KNOWN_FILE)):
        check_components(tmp_path, src)
