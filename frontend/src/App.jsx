import { useEffect } from 'react';

export default function App() {
  useEffect(() => {
    let cancelled = false;
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Carregando mapa…';
    import('./taboa/bootstrap.js')
      .then(({ bootstrapTaboa }) => {
        if (!cancelled) bootstrapTaboa();
      })
      .catch((e) => {
        console.error('Falha ao carregar bootstrap:', e);
        if (!cancelled && statusEl) statusEl.textContent = 'Erro ao carregar o mapa.';
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand" id="topbarHome">
          <img
            src="/Logos/lg_taboa_semslogan.png"
            alt="Taboa"
            className="topbar-logo-img topbar-logo-taboa-light"
            width={160}
            height={40}
            decoding="async"
            fetchPriority="low"
          />
        </div>
        <div className="topbar-actions">
          <div className="status-pill" id="status" hidden>Iniciando…</div>
          <div className="scan-status" id="scanStatus" hidden role="status" aria-live="polite" aria-atomic="true">
            <div className="scan-status-copy">
              <span className="scan-status-title" id="scanStatusTitle">Status</span>
              <span className="scan-status-meta" id="scanStatusMeta">Consultando municípios da faixa…</span>
            </div>
            <div
              className="scan-status-track"
              id="scanStatusTrack"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={0}
              aria-labelledby="scanStatusTitle"
            >
              <div className="scan-status-fill" id="scanStatusFill" />
            </div>
            <span className="scan-status-pct" id="scanStatusPct">0%</span>
          </div>
          <div className="alerts-tabs topbar-help-tabs">
            <a href="#orientacoes" className="alerts-tab" id="btnAjudaConsulta" aria-pressed="false">
              Orientações para consulta
            </a>
          </div>
        </div>
      </header>

      <div className="map-wrap" id="pageMapa">
        <div id="map" />

        {/* ── Painel analítico direito ──────────────────────── */}
        <div className="analytics-wrap collapsed" id="analyticsWrap">
          <button
            type="button"
            className="analytics-toggle"
            id="analyticsToggle"
            title="Abrir painel analítico"
            aria-label="Abrir painel analítico"
            aria-expanded="false"
            aria-controls="analyticsPanelBody"
          >
            <span className="toggle-icon" aria-hidden="true">‹</span>
            <span className="analytics-toggle-label">Abrir painel analítico</span>
          </button>
          <div className="analytics-panel">
            <div className="analytics-header">
              <span>Analítico</span>
              <div className="analytics-header-actions">
                <span id="analyticsAlertsCount" className="analytics-count">—</span>
                <button
                  type="button"
                  className="analytics-close"
                  id="analyticsClose"
                  title="Fechar painel analítico"
                  aria-label="Fechar painel analítico"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
            <div className="analytics-body" id="analyticsPanelBody">
              <div className="analytic-empty">Carregue os dados para visualizar o painel analítico.</div>
            </div>
          </div>
        </div>

        {/* ── Sidebar esquerda ──────────────────────────────── */}
        <div className="sidebar-wrap" id="sidebarWrap">
          <div className="sidebar">

            {/* ── Abas: Consulta de Imóvel Rural | Camada ── */}
            <div className="sidebar-filter-area">

              <div className="alerts-tabs filter-tabs-bar">
                <button type="button" className="alerts-tab active" data-ftab="consulta" aria-pressed="true">Consulta de Imóvel Rural</button>
                <button type="button" className="alerts-tab" data-ftab="camada" aria-pressed="false">Camadas</button>
              </div>

              {/* Período e assentamento ficam no DOM (varredura/login), sem aba de Filtro */}
              <div id="filterTabFiltro" className="filter-tab-content" hidden>
                <div className="fs-section">
                  <span className="fs-title">Período</span>
                  <div className="period-presets" role="group" aria-label="Atalhos de período">
                    <button type="button" className="period-chip" data-period-preset="since2020" aria-pressed="true">2020–hoje</button>
                    <button type="button" className="period-chip" data-period-preset="thisYear" aria-pressed="false">Este ano</button>
                    <button type="button" className="period-chip" data-period-preset="last12" aria-pressed="false">12 meses</button>
                    <button type="button" className="period-chip" data-period-preset="last5y" aria-pressed="false">5 anos</button>
                    <button type="button" className="period-chip" data-period-preset="all" aria-pressed="false">Desde 2015</button>
                  </div>
                  <div className="period-range">
                    <label className="period-field">
                      <span className="period-field-label">De</span>
                      <span className="period-field-value" id="periodStartLabel">01 jan 2020</span>
                      <input type="date" id="periodStart" className="period-date-native" defaultValue="2020-01-01" min="2015-01-01" aria-label="Data inicial" />
                    </label>
                    <span className="period-range-sep" aria-hidden="true">
                      <span className="period-range-line" />
                    </span>
                    <label className="period-field">
                      <span className="period-field-label">Até</span>
                      <span className="period-field-value" id="periodEndLabel">hoje</span>
                      <input type="date" id="periodEnd" className="period-date-native" aria-label="Data final" />
                    </label>
                  </div>
                  <p className="period-summary" id="periodSummary" aria-live="polite" />
                  <input type="hidden" id="startDate" defaultValue="" />
                  <input type="hidden" id="endDate" />
                </div>
                <div className="fs-section shapes-scan-section" id="shapesScanSection">
                  <span className="fs-title">Assentamento</span>
                  <div className="filter-combobox assentamento-combobox">
                    <input
                      type="text"
                      id="selectAssentamento"
                      className="filter-input filter-combobox-input assentamento-combobox-input"
                      placeholder="Selecione um assentamento"
                      autoComplete="off"
                      aria-label="Assentamento"
                      aria-autocomplete="list"
                    />
                    <button type="button" className="filter-combobox-arrow" id="btnAssentamentoToggle" tabIndex={-1} aria-label="Abrir lista de assentamentos">▾</button>
                    <ul className="filter-combobox-list assentamento-combobox-list" id="assentamentosDropdown" hidden role="listbox"></ul>
                  </div>
                </div>
              </div>

              {/* Conteúdo: Consulta de IR */}
              <div id="filterTabConsulta" className="filter-tab-content consulta-tab-content active">
                <div className="consulta-form">
                  <div className="consulta-inserts">
                  <div className="consulta-field">
                    <span className="consulta-label">Município</span>
                    <div className="filter-combobox">
                      <input type="text" id="filterMunicipio" className="filter-input filter-combobox-input" placeholder="Município…" autoComplete="off" />
                      <button type="button" className="filter-combobox-arrow" id="btnMunicipioToggle" tabIndex={-1}>▾</button>
                      <ul className="filter-combobox-list" id="municipiosDropdown" hidden></ul>
                    </div>
                  </div>
                  <div className="consulta-field">
                    <span className="consulta-label">Imóvel rural (CAR)</span>
                    <div className="filter-combobox">
                      <input type="text" id="consultaImovel" className="filter-input filter-combobox-input" placeholder="Buscar pelo CAR…" autoComplete="off" />
                      <button type="button" className="filter-combobox-arrow" id="btnImovelToggle" tabIndex={-1}>▾</button>
                      <ul className="filter-combobox-list" id="imoveisDropdown" hidden></ul>
                    </div>
                  </div>
                  <div className="consulta-field consulta-cadastro-field">
                    <span className="consulta-label">Informações cadastrais</span>
                    <div className="consulta-coords">
                      <label className="consulta-coord-box">
                        <span className="consulta-coord-name">Nome</span>
                        <input type="text" id="consultaNome" className="consulta-coord-input" placeholder="Nome completo" autoComplete="name" />
                      </label>
                      <label className="consulta-coord-box">
                        <span className="consulta-coord-name">CPF</span>
                        <input type="text" id="consultaCpf" className="consulta-coord-input" placeholder="000.000.000-00" inputMode="numeric" autoComplete="off" maxLength={14} />
                      </label>
                    </div>
                    <label className="consulta-coord-box">
                      <span className="consulta-coord-name">Tamanho da propriedade (ha)</span>
                      <input type="text" id="consultaAreaHa" className="consulta-coord-input" placeholder="Ex.: 329,07" inputMode="decimal" autoComplete="off" />
                    </label>
                  </div>
                  <div className="consulta-field consulta-coords-field">
                    <span className="consulta-label">Coordenadas</span>
                    <div className="consulta-coords">
                      <label className="consulta-coord-box">
                        <span className="consulta-coord-name">Insira a Latitude</span>
                        <input type="text" id="consultaLat" className="consulta-coord-input" placeholder="-16,4497 ou DMS" />
                      </label>
                      <label className="consulta-coord-box">
                        <span className="consulta-coord-name">Insira a Longitude</span>
                        <input type="text" id="consultaLng" className="consulta-coord-input" placeholder="-39,0647 ou DMS" />
                      </label>
                    </div>
                  </div>
                  <div className="consulta-field consulta-kml-field">
                    <span className="consulta-label">Arquivo KML</span>
                    <label className="consulta-upload" htmlFor="consultaKml" aria-label="Enviar arquivo KML">
                      <input
                        type="file"
                        id="consultaKml"
                        className="consulta-in-kml"
                        accept=".kml,.xml,application/vnd.google-earth.kml+xml,text/xml,application/xml"
                      />
                      <span className="consulta-upload-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="22" height="22">
                          <path d="M19.4 10.1A7.5 7.5 0 0 0 12 4a7.5 7.5 0 0 0-6.7 4.1A6 6 0 0 0 6 20h13a5 5 0 0 0 .4-9.9z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                          <path d="M12 16V9M9.2 11.2 12 8.4l2.8 2.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span id="consultaKmlFilename" className="consulta-upload-text" aria-live="polite">Enviar Arquivo</span>
                    </label>
                    <span id="consultaKmlErr" className="consulta-kml-err" hidden />
                  </div>
                  <div className="consulta-field consulta-map-field">
                    <span className="consulta-label">Inserir no Mapa</span>
                    <div className="consulta-map-tools">
                      <button type="button" className="btn btn-ghost btn-sm" id="btnConsultaPontoMapa">
                        <span className="consulta-tool-icon" aria-hidden="true">📍</span>
                        Inserir ponto no mapa
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" id="btnConsultaDesenhar">
                        <span className="consulta-tool-icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16" width="14" height="14">
                            <polygon points="3,12 6,3 13,5 12,13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                            <circle cx="3" cy="12" r="1.6" fill="currentColor" />
                            <circle cx="6" cy="3" r="1.6" fill="currentColor" />
                            <circle cx="13" cy="5" r="1.6" fill="currentColor" />
                            <circle cx="12" cy="13" r="1.6" fill="currentColor" />
                          </svg>
                        </span>
                        Desenhar polígono no mapa
                      </button>
                    </div>
                  </div>
                  </div>
                  <p id="consultaGeomStatus" className="consulta-mun-status" aria-live="polite" hidden />
                  <p id="consultaMapHint" className="consulta-kml-hint" hidden />
                </div>
                <div className="consulta-result" id="consultaResult" hidden></div>
              </div>

              {/* Conteúdo: Camada */}
              <div id="filterTabCamada" className="filter-tab-content" hidden>

                <div className="filter-group layers-list-group" id="remoteWmsLayersWrap">
                  <ul className="remote-wms-legend" aria-label="Camadas do mapa">
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#a1a1aa', '--layer-color-soft': '#e4e4e7' }}
                        >
                          <input type="checkbox" id="chkShape" aria-label="Municípios. Fonte: IBGE" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Municípios</span>
                          <span className="layer-row-source">Fonte: IBGE</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#ef4444', '--layer-color-soft': '#fecaca' }}
                        >
                          <input type="checkbox" id="chkProdes" defaultChecked aria-label="Alertas - PRODES. Desmatamento, fonte: INPE" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Alertas - PRODES</span>
                          <span className="layer-row-source">Desmatamento · INPE</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#c2410c', '--layer-color-soft': '#fb923c' }}
                        >
                          <input type="checkbox" id="chkIncraAssentamentos" aria-label="Assentamentos. Fonte: INCRA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Assentamentos</span>
                          <span className="layer-row-source">Fonte: INCRA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#eab308', '--layer-color-soft': '#facc15' }}
                        >
                          <input type="checkbox" id="chkInemaImoveisRurais" defaultChecked={false} autoComplete="off" aria-label="Imóveis rurais. Fonte: INEMA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Imóveis rurais</span>
                          <span className="layer-row-source">Fonte: INEMA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#166534', '--layer-color-soft': '#86efac' }}
                        >
                          <input type="checkbox" id="chkInemaReservaLegal" defaultChecked={false} autoComplete="off" aria-label="Reserva legal. Fonte: INEMA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Reserva legal</span>
                          <span className="layer-row-source">Fonte: INEMA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#0e7490', '--layer-color-soft': '#67e8f9' }}
                        >
                          <input type="checkbox" id="chkInemaApp" defaultChecked={false} autoComplete="off" aria-label="Áreas de preservação permanente. Fonte: INEMA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Áreas de preservação permanente</span>
                          <span className="layer-row-source">Fonte: INEMA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#059669', '--layer-color-soft': '#34d399' }}
                        >
                          <input type="checkbox" id="chkFunaiIndigenas" aria-label="Terras indígenas. Fonte: FUNAI" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Terras indígenas</span>
                          <span className="layer-row-source">Fonte: FUNAI</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#be185d', '--layer-color-soft': '#f9a8d4' }}
                        >
                          <input type="checkbox" id="chkIncraQuilombolas" aria-label="Territórios quilombolas. Fonte: INCRA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Territórios quilombolas</span>
                          <span className="layer-row-source">Fonte: INCRA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#0f766e', '--layer-color-soft': '#5eead4' }}
                        >
                          <input type="checkbox" id="chkIcmbioUcFederais" aria-label="Unidades de Conservação federais. Fonte: ICMBio" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Unidades de Conservação federais</span>
                          <span className="layer-row-source">Fonte: ICMBio</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#1d4ed8', '--layer-color-soft': '#93c5fd' }}
                        >
                          <input type="checkbox" id="chkInemaUcEstaduais" aria-label="Unidades de Conservação estaduais. Fonte: INEMA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Unidades de Conservação estaduais</span>
                          <span className="layer-row-source">Fonte: INEMA</span>
                        </span>
                      </label>
                    </li>
                    <li className="layer-row-item">
                      <label className="layer-row">
                        <span
                          className="toggle-switch"
                          style={{ '--layer-color': '#6d28d9', '--layer-color-soft': '#c4b5fd' }}
                        >
                          <input type="checkbox" id="chkInemaUcMunicipais" aria-label="Unidades de Conservação municipais. Fonte: INEMA" />
                          <span className="toggle-switch-slider" aria-hidden="true" />
                        </span>
                        <span className="layer-row-text">
                          <span className="layer-row-title">Unidades de Conservação municipais</span>
                          <span className="layer-row-source">Fonte: INEMA</span>
                        </span>
                      </label>
                    </li>
                  </ul>
                </div>

              </div>

            </div>
            {/* fim sidebar-filter-area */}

            {/* Barra inferior: Consulta de Imóvel Rural */}
            <div className="sidebar-report-row" id="filtroActionRow" hidden>
              <button type="button" className="btn btn-primary btn-sm" id="btnAplicarFiltros">Aplicar Filtros</button>
              <button type="button" className="btn btn-ghost btn-sm" id="btnResetarFiltros">Resetar</button>
            </div>
            <div className="sidebar-report-row sidebar-report-row--triple" id="consultaActionRow">
              <button type="button" className="btn btn-primary btn-sm" id="btnConsultaExecutar">Consultar</button>
              <button type="button" className="btn btn-ghost btn-sm" id="btnConsultaLimpar">Limpar</button>
              <button type="button" className="btn btn-ghost btn-sm" id="btnConsultaResetar">Resetar</button>
            </div>

          </div>
          <button type="button" className="sidebar-toggle" id="sidebarToggle" title="Recolher / Expandir">
            <span className="toggle-icon">‹</span>
          </button>
        </div>
      </div>

      <main className="ajuda-page" id="pageOrientacoes" hidden>
        <div className="ajuda-page-inner">
          <p className="ajuda-kicker">Módulo de Desmatamento</p>
          <h1 id="ajudaConsultaTitle">Orientações para consulta</h1>

          <ol className="ajuda-steps">
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">1</span>
              <div className="ajuda-step-body">
                <h3>Abra a Consulta de Imóvel Rural</h3>
                <p>
                  Na caixa da esquerda, a primeira aba já vem selecionada. É nela que você define a área
                  de análise. A aba Camadas serve só para ligar ou desligar malhas no mapa.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">2</span>
              <div className="ajuda-step-body">
                <h3>Insira o dado vetorial da área</h3>
                <p>
                  Este é o caminho prático da consulta. Use uma destas opções: par de coordenadas
                  (latitude e longitude, em decimal ou DMS); arquivo KML de ponto ou polígono
                  (linhas e KMZ não são aceitos); inserir ponto no mapa; ou desenhar um polígono no mapa.
                  Em um ponto, o buffer tem a mesma área do tamanho da propriedade, em hectares.
                  Polígono é analisado na forma enviada.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">3</span>
              <div className="ajuda-step-body">
                <h3>Município e CAR são atalhos</h3>
                <p>
                  Se quiser, selecione o município para filtrar a lista e dar zoom no território.
                  Também pode buscar o imóvel pelo CAR/CEFIR para o mapa ir até a propriedade.
                  Esses campos ajudam a localizar, mas a consulta em si usa a área vetorial inserida.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">4</span>
              <div className="ajuda-step-body">
                <h3>Preencha as informações cadastrais</h3>
                <p>
                  Informe Nome, CPF e o tamanho da propriedade em hectares. O tamanho define o buffer
                  quando a consulta parte de um ponto e entra no quadro de informações cadastrais do relatório,
                  junto com a origem da inserção, o município e a área de análise.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">5</span>
              <div className="ajuda-step-body">
                <h3>Clique em Consultar</h3>
                <p>
                  O sistema cruza a área com os desmatamentos do PRODES (INPE, desde 2020) e com as restrições
                  legais (unidades de conservação, reserva legal, APP, terras indígenas e
                  territórios quilombolas). No mapa da tela aparecem a área analisada, o imóvel com CAR
                  e os desmatamentos PRODES que tocam a área. Reserva legal e APP da propriedade saem no mapa do laudo.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">6</span>
              <div className="ajuda-step-body">
                <h3>Baixe o relatório</h3>
                <p>
                  Depois da consulta, use Baixar relatório. O PDF traz cadastro, o cruzamento com o PRODES
                  (ano, data da imagem e área sobreposta de cada desmatamento), restrições legais, tabela de
                  unidades de conservação com a porcentagem de sobreposição, e o mapa de satélite.
                </p>
              </div>
            </li>
            <li className="ajuda-step">
              <span className="ajuda-step-num" aria-hidden="true">7</span>
              <div className="ajuda-step-body">
                <h3>Limpar e Resetar</h3>
                <p>
                  Limpar esvazia os campos e tira do mapa o município, o imóvel e a área
                  da consulta, sem mudar o zoom nem as camadas que você ligou ou
                  reordenou na aba Camadas. Resetar devolve o mapa ao enquadramento
                  inicial da faixa, sem apagar o que você digitou.
                </p>
              </div>
            </li>
          </ol>

          <div className="ajuda-page-actions">
            <button type="button" className="btn btn-primary" id="btnAjudaVoltar">Voltar ao mapa</button>
          </div>
        </div>
      </main>

      <footer className="app-footer">SIGWeb Tabôa · v1.0 | 2026</footer>

      {/* Overlay de carregamento */}
      <div className="loading-overlay hidden" id="loadingOverlay" role="status" aria-live="polite">
        <div className="loading-box">
          <div className="loading-spinner" aria-hidden="true" />
          <div className="loading-label" id="loadingLabel">Processando…</div>
        </div>
      </div>

    </div>
  );
}
