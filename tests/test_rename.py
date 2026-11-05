from conftest import git
from perchtools.rename import rename_product_strings, rename_text


def test_renames_inside_message():
    src = '<message name="IDS_PRODUCT_NAME" desc="The Chromium name">Chromium</message>'
    assert rename_text(src) == '<message name="IDS_PRODUCT_NAME" desc="The Chromium name">Perch</message>'


def test_keeps_credit_phrases():
    src = '<message name="IDS_ABOUT">Chromium is made possible by the Chromium open source project. Copyright The Chromium Authors.</message>'
    assert rename_text(src) == '<message name="IDS_ABOUT">Perch is made possible by the Chromium open source project. Copyright The Chromium Authors.</message>'


def test_keeps_chromium_project_and_os():
    src = '<message name="X">the Chromium project and Chromium OS</message>'
    assert rename_text(src) == src


def test_whole_word_only():
    assert "Chromiums" in rename_text('<message name="X">Chromiums</message>')
    assert "ChromiumBrowser" in rename_text('<message name="X">ChromiumBrowser</message>')


def test_multiline_message():
    src = '<message name="X" desc="d">\n  Chromium one\n  Chromium two\n  Chromium three\n</message>'
    assert rename_text(src) == '<message name="X" desc="d">\n  Perch one\n  Perch two\n  Perch three\n</message>'


def test_comments_untouched():
    src = '<!-- Chromium --><message name="X">Chromium</message><!-- Chromium -->'
    assert rename_text(src) == '<!-- Chromium --><message name="X">Perch</message><!-- Chromium -->'


def test_placeholders_untouched():
    src = '<message name="X">Chromium <ph name="CHROMIUM_VERSION">$1<ex>Chromium 1</ex></ph></message>'
    assert rename_text(src) == '<message name="X">Perch <ph name="CHROMIUM_VERSION">$1<ex>Chromium 1</ex></ph></message>'


def test_generator_touches_only_listed_files(chromium_like):
    src = chromium_like
    (src / "app").mkdir()
    (src / "app" / "chromium_strings.grd").write_text('<message name="A">Chromium</message>\n')
    (src / "app" / "settings_chromium_strings.grdp").write_text('<message name="B">Chromium</message>\n')
    (src / "app" / "generated_resources.grd").write_text('<message name="C">Chromium</message>\n')
    (src / "app" / "chromium_strings_fr.xtb").write_text('<translation id="1">Chromium</translation>\n')
    git(src, "add", "-A")
    rename_product_strings(src)
    assert "Perch" in (src / "app" / "chromium_strings.grd").read_text()
    assert "Perch" in (src / "app" / "settings_chromium_strings.grdp").read_text()
    assert "Perch" not in (src / "app" / "generated_resources.grd").read_text()
    assert "Perch" not in (src / "app" / "chromium_strings_fr.xtb").read_text()
